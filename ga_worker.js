// --- ga_worker.js ---

// --- Utilidades Numéricas ---
function c(re=0,im=0){return{re,im}} 
function cAdd(a,b){return c(a.re+b.re,a.im+b.im)} 
function cSub(a,b){return c(a.re-b.re,a.im-b.im)} 
function cMul(a,b){return c(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re)} 
function cConj(a){return c(a.re,-a.im)} 
function cAbs(a){return Math.hypot(a.re,a.im)} 
function cDiv(a,b){const d=b.re*b.re+b.im*b.im||1e-30;return c((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d)} 
function angDeg(a){return Math.atan2(a.im,a.re)*180/Math.PI}

const GA_PENALTIES = {
    UNSERVED_NODE: 5000000,   
    UNSERVED_MW: 10000000,    
    VOLTAGE_VIOL_PU: 50000,
    SMAX_VIOL_MVA: 10000,
    LOOP_ALIMENTADOR: 1e15,   
    MAX_NA_VIOL: 1e8
};

// --- Topologia ---
function analisarTopologia(n, linhas, sources) {
    const adj = Array(n + 1).fill(0).map(() => []);
    linhas.forEach(l => {
        if (l && typeof l.de === 'number' && typeof l.para === 'number') {
            adj[l.de].push(l.para);
            adj[l.para].push(l.de);
        }
    });

    const zoneMap = new Map(); 
    const parentMap = new Map(); 
    const q = [];

    sources.forEach(s => {
        if (s <= n) {
            q.push({ u: s, src: s });
            zoneMap.set(s, s);
            parentMap.set(s, -1); 
        }
    });

    let head = 0;
    while (head < q.length) {
        const { u, src } = q[head++];
        for (const v of adj[u]) {
            if (v === parentMap.get(u)) continue; 
            if (zoneMap.has(v)) {
                return { ok: false, msg: `Loop/Redundância entre ${u} e ${v}`, zones: {}, unserved: new Set() };
            } else {
                zoneMap.set(v, src);
                parentMap.set(v, u);
                q.push({ u: v, src: src });
            }
        }
    }

    const unserved = new Set();
    for (let b = 1; b <= n; b++) if (!zoneMap.has(b)) unserved.add(b);
    return { ok: true, msg: 'OK', zones: Object.fromEntries(zoneMap), unserved };
}

// --- Fluxo de Potência ---
async function runFluxo(linhasData, nb, Sbase, Vbase_kV, cargas, sourceBuses) {
    const topo = analisarTopologia(nb, linhasData, sourceBuses);
    if (!topo.ok) return { resBarras: [], resRamos: [], perdasMWtotal: 0, unservedBuses: Array.from(topo.unserved), error: topo.msg };

    const Zbase = (Vbase_kV * Vbase_kV) / Sbase;
    const Ibase_A = (Sbase * 1000) / (Math.sqrt(3) * Vbase_kV);

    const V = Array(nb + 1).fill(0).map(() => c(0, 0));
    sourceBuses.forEach(s => { if (s <= nb) V[s] = c(1, 0); });

    const S_inj = Array(nb + 1).fill(0).map(() => c(0, 0));
    for (let b = 1; b <= nb; b++) {
        if (cargas[b] && topo.zones[b]) {
            S_inj[b] = c(parseFloat(cargas[b].P) / Sbase, parseFloat(cargas[b].Q) / Sbase);
        }
    }

    const adj = Array(nb + 1).fill(0).map(() => []);
    linhasData.forEach(l => { adj[l.de].push(l.para); adj[l.para].push(l.de); });

    const orderFwd = [];
    const parent = new Map();
    const qBFS = [...sourceBuses.filter(s => s <= nb)];
    const visited = new Set(qBFS);
    let h = 0;

    while (h < qBFS.length) {
        const u = qBFS[h++];
        orderFwd.push(u);
        for (const v of adj[u]) {
            if (!visited.has(v) && topo.zones[v]) {
                visited.add(v);
                parent.set(v, u);
                qBFS.push(v);
            }
        }
    }
    const orderBwd = [...orderFwd].reverse();
    const ramoMap = {}; 
    linhasData.forEach(r => { ramoMap[`${r.de}-${r.para}`] = r; ramoMap[`${r.para}-${r.de}`] = r; });

    const iterMax = 50;
    const IramoFinal = {}; 

    for (let it = 0; it < iterMax; it++) {
        const Iload = Array(nb + 1).fill(0).map(() => c(0, 0));
        for (const b of orderBwd) {
            if (sourceBuses.includes(b)) continue;
            if (cAbs(V[b]) > 1e-5) Iload[b] = cConj(cDiv(S_inj[b], V[b]));
        }

        const Isoma = Array(nb + 1).fill(0).map(() => c(0, 0));
        for (const b of orderBwd) {
            if (sourceBuses.includes(b)) continue;
            const p = parent.get(b);
            if (p) {
                const i_flow = cAdd(Iload[b], Isoma[b]);
                IramoFinal[`${p}-${b}`] = i_flow; 
                Isoma[p] = cAdd(Isoma[p], i_flow);
            }
        }

        const V_ant = V.map(v => c(v.re, v.im));
        for (const u of orderFwd) {
            for (const v of adj[u]) {
                if (parent.get(v) === u) { 
                    const r = ramoMap[`${u}-${v}`];
                    const Zr = r ? c((r.R || 0) / Zbase, (r.X || 0) / Zbase) : c(0, 0);
                    const drop = cMul(Zr, IramoFinal[`${u}-${v}`] || c(0, 0));
                    V[v] = cSub(V[u], drop);
                }
            }
        }
        let maxDv = 0;
        for (let b = 1; b <= nb; b++) if (topo.zones[b]) maxDv = Math.max(maxDv, cAbs(cSub(V[b], V_ant[b])));
        if (maxDv < 1e-6) break;
    }

    const resBarras = [];
    for (let b = 1; b <= nb; b++) {
        const z = topo.zones[b];
        resBarras.push({ barra: b, zona: z, Vmag: z ? cAbs(V[b]) : 0, Vang: z ? angDeg(V[b]) : 0, isConnected: !!z });
    }

    let perdasMWtotal = 0;
    const resRamos = [];

    linhasData.forEach(l => {
        let I = c(0,0);
        let flowFromDe = true;

        if (parent.get(l.para) === l.de) { I = IramoFinal[`${l.de}-${l.para}`] || c(0,0); flowFromDe = true; } 
        else if (parent.get(l.de) === l.para) { I = IramoFinal[`${l.para}-${l.de}`] || c(0,0); flowFromDe = false; }

        const V_ref = flowFromDe ? V[l.de] : V[l.para];
        const S_flow_pu = cMul(V_ref, cConj(I));
        
        const P_mw = S_flow_pu.re * Sbase;
        const Q_mvar = S_flow_pu.im * Sbase;
        const S_mva = cAbs(S_flow_pu) * Sbase;
        
        const modI = cAbs(I);
        const I_Ampere = modI * Ibase_A;
        const R_pu = (l.R || 0) / Zbase;
        const Loss_mw = modI * modI * R_pu * Sbase;

        if(topo.zones[l.de] && topo.zones[l.para]) perdasMWtotal += Loss_mw;

        resRamos.push({
            ...l, zona: topo.zones[l.de], 
            Pmw: isFinite(P_mw) ? Math.abs(P_mw) : 0, Qmvar: isFinite(Q_mvar) ? Math.abs(Q_mvar) : 0, Smva: isFinite(S_mva) ? S_mva : 0,
            perdasMW: isFinite(Loss_mw) ? Loss_mw : 0, I_A: isFinite(I_Ampere) ? I_Ampere : 0 
        });
    });

    return { resBarras, resRamos, perdasMWtotal, unservedBuses: Array.from(topo.unserved), error: null };
}

// --- Fitness ---
async function calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses) {
    const falhaSet = new Set(linhaFalhaKeys);
    let activeLines = [];
    let numNA = 0;
    
    individual.forEach((gene, i) => {
        if (gene === 1 && allLines[i]) {
            const l = allLines[i];
            const k1 = `${l.de}-${l.para}`;
            const k2 = `${l.para}-${l.de}`;
            
            if (!falhaSet.has(k1) && !falhaSet.has(k2)) {
                activeLines.push(l);
                if(l.isSwitch) numNA++;
            }
        }
    });

    let fitness = 0;

    const res = await runFluxo(activeLines, nb, Sbase, Vbase_kV, cargas, sourceBuses);

    if(res.error) {
        fitness += GA_PENALTIES.LOOP_ALIMENTADOR; 
        return { fitness, data: { error: res.error, resBarras: [], resRamos: [] } };
    }

    let unservedP = 0;
    res.unservedBuses.forEach(b => { if(cargas[b]) unservedP += (cargas[b].P || 0); });
    
    fitness += unservedP * GA_PENALTIES.UNSERVED_MW;
    fitness += res.unservedBuses.length * GA_PENALTIES.UNSERVED_NODE; 

    fitness += res.perdasMWtotal; 

    res.resBarras.forEach(b => {
        if(b.isConnected) {
            if(b.Vmag < vMin) fitness += (vMin - b.Vmag) * GA_PENALTIES.VOLTAGE_VIOL_PU;
            else if(b.Vmag > vMax) fitness += (b.Vmag - vMax) * GA_PENALTIES.VOLTAGE_VIOL_PU;
        }
    });

    res.resRamos.forEach(r => {
        if(r.Smva > r.Smax) fitness += (r.Smva - r.Smax) * GA_PENALTIES.SMAX_VIOL_MVA;
    });
    res.resRamos.forEach(r => {
        if(r.Smva > r.Smax) fitness += (r.Smva - r.Smax) * GA_PENALTIES.SMAX_VIOL_MVA;
    });

    // CORREÇÃO AQUI: Aplica a penalidade se o AG abrir chaves demais
    if (numNA > maxNALinhas) {
        fitness += (numNA - maxNALinhas) * GA_PENALTIES.MAX_NA_VIOL;
    }

    return { fitness, data: { ...res, currentLinhas: activeLines, numNA_Usadas: numNA } };
}

    return { fitness, data: { ...res, currentLinhas: activeLines, numNA_Usadas: numNA } };
}

self.onmessage = async (event) => {
    const { individual, index, staticData } = event.data;
    const { allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses } = staticData;
    try {
        const result = await calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses);
        self.postMessage({ index: index, result });
    } catch (error) {
        self.postMessage({ index: index, result: { fitness: Infinity }, error: error.message });
    }
};
