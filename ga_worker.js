// --- ga_worker.js ---

// --- Utilidades Numéricas (Complex Numbers) ---
function c(re=0,im=0){return{re,im}} 
function cAdd(a,b){return c(a.re+b.re,a.im+b.im)} 
function cSub(a,b){return c(a.re-b.re,a.im-b.im)} 
function cMul(a,b){return c(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re)} 
function cConj(a){return c(a.re,-a.im)} 
function cAbs(a){return Math.hypot(a.re,a.im)} 
function cDiv(a,b){const d=b.re*b.re+b.im*b.im||1e-30;return c((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d)} 
function angDeg(a){return Math.atan2(a.im,a.re)*180/Math.PI}

// --- Penalidades do GA ---
const GA_PENALTIES = {
    UNSERVED_MW: 100000,
    VOLTAGE_VIOL_PU: 50000,
    SMAX_VIOL_MVA: 10000,
    LOOP_ALIMENTADOR: 1e12, // Penalidade "Mortal" para loops ou conexões redundantes
    MAX_NA_VIOL: 1e8
};

// --- Validação de Topologia (Radialidade Estrita) ---
function analisarTopologia(n, linhas, sources) {
    const adj = Array(n + 1).fill(0).map(() => []);
    linhas.forEach(l => {
        if (l && typeof l.de === 'number' && typeof l.para === 'number') {
            adj[l.de].push(l.para);
            adj[l.para].push(l.de);
        }
    });

    const zoneMap = new Map(); // Map<BarraID, SourceID>
    const parentMap = new Map(); 
    const q = [];

    // Inicializa BFS Multi-Fonte
    sources.forEach(s => {
        if (s <= n) {
            q.push({ u: s, src: s });
            zoneMap.set(s, s);
            parentMap.set(s, -1); // Raiz
        }
    });

    let head = 0;
    
    while (head < q.length) {
        const { u, src } = q[head++];

        for (const v of adj[u]) {
            if (v === parentMap.get(u)) continue; // Ignora volta para o pai

            if (zoneMap.has(v)) {
                const existingSrc = zoneMap.get(v);
                // SE JÁ TEM ZONA:
                // 1. Se for zona diferente: Curto entre alimentadores.
                // 2. Se for mesma zona: Loop (anel) radial.
                // Em ambos os casos, a topologia não é radial simples.
                return { ok: false, msg: `Redundância/Loop detectado entre ${u} e ${v} (Zonas ${src}/${existingSrc})`, zones: {}, unserved: new Set() };
            } else {
                // Conquista nó
                zoneMap.set(v, src);
                parentMap.set(v, u);
                q.push({ u: v, src: src });
            }
        }
    }

    const unserved = new Set();
    for (let b = 1; b <= n; b++) {
        if (!zoneMap.has(b)) unserved.add(b);
    }

    return { ok: true, msg: 'OK', zones: Object.fromEntries(zoneMap), unserved };
}

// --- Fluxo de Potência (Backward/Forward Sweep) ---
async function runFluxo(linhasData, nb, Sbase, Vbase_kV, cargas, sourceBuses) {
    // 1. Validação Topológica
    const topo = analisarTopologia(nb, linhasData, sourceBuses);

    if (!topo.ok) {
        // Retorna erro para aplicar penalidade máxima no AG
        return { resBarras: [], resRamos: [], perdasMWtotal: 0, unservedBuses: new Set(), error: topo.msg };
    }

    const Zbase = (Vbase_kV * Vbase_kV) / Sbase;
    const V = Array(nb + 1).fill(0).map(() => c(0, 0));
    
    sourceBuses.forEach(s => { if (s <= nb) V[s] = c(1, 0); });

    // Injeção de Potência (S_load)
    const S_inj = Array(nb + 1).fill(0).map(() => c(0, 0));
    for (let b = 1; b <= nb; b++) {
        if (cargas[b] && topo.zones[b]) {
            S_inj[b] = c(parseFloat(cargas[b].P) / Sbase, parseFloat(cargas[b].Q) / Sbase);
        }
    }

    // Montar Árvore Orientada (BFS para definir pais)
    const adj = Array(nb + 1).fill(0).map(() => []);
    linhasData.forEach(l => { adj[l.de].push(l.para); adj[l.para].push(l.de); });

    const orderFwd = [];
    const parent = new Map(); // Map<Filho, Pai>
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

    // Mapa de Ramos para acesso rápido
    // Guardamos a referência para calcular fluxo depois
    const ramoMap = {}; // Key: "u-v"
    linhasData.forEach(r => {
        ramoMap[`${r.de}-${r.para}`] = r;
        ramoMap[`${r.para}-${r.de}`] = r;
    });

    // --- Iteração Sweep ---
    const iterMax = 50;
    const tol = 1e-6;
    
    // Variáveis para armazenar estado final
    const IramoFinal = {}; // Key "u-v" (corrente saindo de u para v)

    for (let it = 0; it < iterMax; it++) {
        const Iload = Array(nb + 1).fill(0).map(() => c(0, 0));
        
        // 1. Calc Iload
        for (const b of orderBwd) {
            if (sourceBuses.includes(b)) continue;
            if (cAbs(V[b]) > 1e-5) {
                // I = conj(S/V)
                Iload[b] = cConj(cDiv(S_inj[b], V[b]));
            }
        }

        const Isoma = Array(nb + 1).fill(0).map(() => c(0, 0)); // Corrente acumulada

        // 2. Backward Sweep
        for (const b of orderBwd) {
            if (sourceBuses.includes(b)) continue;
            const p = parent.get(b);
            if (p) {
                const i_flow = cAdd(Iload[b], Isoma[b]); // Corrente fluindo de P -> B
                IramoFinal[`${p}-${b}`] = i_flow; // Guarda fluxo no sentido Pai->Filho
                Isoma[p] = cAdd(Isoma[p], i_flow);
            }
        }

        const V_ant = V.map(v => c(v.re, v.im));

        // 3. Forward Sweep
        for (const u of orderFwd) {
            for (const v of adj[u]) {
                if (parent.get(v) === u) { // v é filho
                    const r = ramoMap[`${u}-${v}`];
                    const Zr = r ? c((r.R || 0) / Zbase, (r.X || 0) / Zbase) : c(0, 0);
                    const cur = IramoFinal[`${u}-${v}`] || c(0, 0);
                    const drop = cMul(Zr, cur);
                    V[v] = cSub(V[u], drop);
                }
            }
        }

        let maxDv = 0;
        for (let b = 1; b <= nb; b++) {
            if (topo.zones[b]) maxDv = Math.max(maxDv, cAbs(cSub(V[b], V_ant[b])));
        }
        if (maxDv < tol) break;
    }

    // --- Resultados Finais ---
    const resBarras = [];
    for (let b = 1; b <= nb; b++) {
        const z = topo.zones[b];
        resBarras.push({
            barra: b,
            zona: z,
            Vmag: z ? cAbs(V[b]) : 0,
            Vang: z ? angDeg(V[b]) : 0,
            isConnected: !!z
        });
    }

    let perdasMWtotal = 0;
    const resRamos = [];

    linhasData.forEach(l => {
        // Identificar quem é pai e quem é filho para pegar a corrente correta
        // A corrente IramoFinal está armazenada como "Pai-Filho"
        let I = c(0,0);
        let flowFromDe = true; // Flag fluxo sai de 'de'

        if (parent.get(l.para) === l.de) {
            // De é pai de Para
            I = IramoFinal[`${l.de}-${l.para}`] || c(0,0);
            flowFromDe = true;
        } else if (parent.get(l.de) === l.para) {
            // Para é pai de De
            I = IramoFinal[`${l.para}-${l.de}`] || c(0,0); // Corrente flui Para -> De
            // Para exibição, se queremos fluxo em 'de', invertemos? 
            // Geralmente exibimos magnitude, então ok.
            flowFromDe = false; 
        } else {
            // Linha desconectada ou redundante (não deve acontecer aqui se passou validação)
            I = c(0,0);
        }

        // Calcular Potência S = V * conj(I)
        // V deve ser do nó de onde a corrente sai
        const V_ref = flowFromDe ? V[l.de] : V[l.para];
        const S_flow_pu = cMul(V_ref, cConj(I)); // PU
        
        const P_mw = S_flow_pu.re * Sbase;
        const Q_mvar = S_flow_pu.im * Sbase;
        const S_mva = cAbs(S_flow_pu) * Sbase;
        
        // Calcular Perdas I^2 * R
        const modI = cAbs(I);
        const R_pu = (l.R || 0) / Zbase;
        const Loss_pu = modI * modI * R_pu;
        const Loss_mw = Loss_pu * Sbase;

        if(topo.zones[l.de] && topo.zones[l.para]) perdasMWtotal += Loss_mw;

        resRamos.push({
            ...l,
            zona: topo.zones[l.de], 
            Pmw: isFinite(P_mw) ? Math.abs(P_mw) : 0, // Magnitude para display
            Qmvar: isFinite(Q_mvar) ? Math.abs(Q_mvar) : 0,
            Smva: isFinite(S_mva) ? S_mva : 0,
            perdasMW: isFinite(Loss_mw) ? Loss_mw : 0
        });
    });

    return { resBarras, resRamos, perdasMWtotal, unservedBuses: Array.from(topo.unserved), error: null };
}

// --- Fitness ---
async function calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses) {
    const falhaSet = new Set(linhaFalhaKeys);
    
    let activeLines = [];
    let custoChaves = 0;
    let numNA = 0;
    
    individual.forEach((gene, i) => {
        if (gene === 1 && allLines[i]) {
            const l = allLines[i];
            const k1 = `${l.de}-${l.para}`;
            const k2 = `${l.para}-${l.de}`;
            
            if (!falhaSet.has(k1) && !falhaSet.has(k2)) {
                activeLines.push(l);
                custoChaves += (l.custo || 0);
                if(l.isNA) numNA++;
            }
        }
    });

    let fitness = custoChaves;

    if(numNA > maxNALinhas) {
        fitness += (numNA - maxNALinhas) * GA_PENALTIES.MAX_NA_VIOL;
    }

    const res = await runFluxo(activeLines, nb, Sbase, Vbase_kV, cargas, sourceBuses);

    // Se erro topológico (Loop/Redundância), penalidade MAXIMA
    if(res.error) {
        fitness += GA_PENALTIES.LOOP_ALIMENTADOR; 
        // Retorna sem dados detalhados, pois a topologia é inválida
        return { fitness, data: { error: res.error } };
    }

    let unservedP = 0;
    res.unservedBuses.forEach(b => { 
        if(cargas[b]) unservedP += (cargas[b].P || 0); 
    });
    fitness += unservedP * GA_PENALTIES.UNSERVED_MW;

    // Penalidade Perdas
    fitness += res.perdasMWtotal; 

    // Tensão
    res.resBarras.forEach(b => {
        if(b.isConnected) {
            if(b.Vmag < vMin) fitness += (vMin - b.Vmag) * GA_PENALTIES.VOLTAGE_VIOL_PU;
            else if(b.Vmag > vMax) fitness += (b.Vmag - vMax) * GA_PENALTIES.VOLTAGE_VIOL_PU;
        }
    });

    // Sobrecarga nos ramos
    res.resRamos.forEach(r => {
        if(r.Smva > r.Smax) {
            fitness += (r.Smva - r.Smax) * GA_PENALTIES.SMAX_VIOL_MVA;
        }
    });

    return { 
        fitness, 
        data: { 
            ...res, 
            currentLinhas: activeLines, 
            custoChaves, 
            numNA_Usadas: numNA 
        } 
    };
}

self.onmessage = async (event) => {
    const { individual, index, staticData } = event.data;
    const { allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses } = staticData;
    try {
        const result = await calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses);
        self.postMessage({ index: index, result: result });
    } catch (error) {
        self.postMessage({ index: index, result: { fitness: Infinity }, error: error.message });
    }
};
