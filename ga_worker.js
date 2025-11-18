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
    UNSERVED_MW: 50000,
    VOLTAGE_VIOL_PU: 10000,
    SMAX_VIOL_MVA: 5000,
    LOOP_ALIMENTADOR: 100000000, // Penalidade gravíssima para curto entre subestações
    MAX_NA_VIOL: 10000000
};

// --- Nova Lógica de Topologia (Multi-Alimentador / Floresta) ---
function analisarTopologia(n, linhas, sources) {
    // Constrói lista de adjacência
    const adj = Array(n + 1).fill(0).map(() => []);
    linhas.forEach(l => {
        if (l && typeof l.de === 'number' && typeof l.para === 'number') {
            adj[l.de].push(l.para);
            adj[l.para].push(l.de);
        }
    });

    const zoneMap = new Map(); // Map<BarraID, SourceID>
    const parentMap = new Map(); // Para evitar voltar para o pai imediato
    const q = [];

    // Inicializa a fila com TODAS as fontes (BFS Multi-Root)
    // Cada fonte tenta "pintar" a rede com sua cor (ZoneID)
    sources.forEach(s => {
        if (s <= n) {
            q.push({ u: s, src: s });
            zoneMap.set(s, s);
        }
    });

    let head = 0;
    
    while (head < q.length) {
        const { u, src } = q[head++];

        for (const v of adj[u]) {
            if (v === parentMap.get(u)) continue; // Não volta para o pai

            if (zoneMap.has(v)) {
                const existingSrc = zoneMap.get(v);
                if (existingSrc !== src) {
                    // Encontrou uma barra já pintada por OUTRA fonte
                    return { ok: false, msg: `Curto entre alimentadores ${src} e ${existingSrc}`, zones: {}, unserved: new Set() };
                } else {
                    // Encontrou uma barra já pintada pela MESMA fonte (e não é o pai) -> Loop Radial
                    return { ok: false, msg: `Loop radial na Zona ${src}`, zones: {}, unserved: new Set() };
                }
            } else {
                // Barra livre, conquista para a zona atual
                zoneMap.set(v, src);
                parentMap.set(v, u);
                q.push({ u: v, src: src });
            }
        }
    }

    // Verifica isoladas
    const unserved = new Set();
    for (let b = 1; b <= n; b++) {
        if (!zoneMap.has(b)) unserved.add(b);
    }

    return { ok: true, msg: 'OK', zones: Object.fromEntries(zoneMap), unserved };
}

// --- Fluxo de Potência (Backward/Forward Sweep por Zona) ---
async function runFluxo(linhasData, nb, Sbase, Vbase_kV, cargas, sourceBuses) {
    // 1. Validação Topológica Rigorosa
    const topo = analisarTopologia(nb, linhasData, sourceBuses);

    if (!topo.ok) {
        // Retorna erro para aplicar penalidade máxima
        return { resBarras: [], resRamos: [], perdasMWtotal: 0, unservedBuses: new Set(), error: topo.msg };
    }

    const Zbase = (Vbase_kV * Vbase_kV) / Sbase;
    const V = Array(nb + 1).fill(0).map(() => c(0, 0));
    
    // Inicializa tensões das fontes (1.0 pu)
    sourceBuses.forEach(s => { if (s <= nb) V[s] = c(1, 0); });

    // Injeção de Potência (S = P + jQ) nas barras conectadas
    const S_inj = Array(nb + 1).fill(0).map(() => c(0, 0));
    for (let b = 1; b <= nb; b++) {
        if (cargas[b] && topo.zones[b]) {
            // Carga convencional (negativo na injeção de corrente, mas tratado no Iload)
            S_inj[b] = c(parseFloat(cargas[b].P) / Sbase, parseFloat(cargas[b].Q) / Sbase);
        }
    }

    // Montagem da árvore orientada (BFS para definir pais e ordem de varredura)
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
            if (!visited.has(v) && topo.zones[v]) { // Só visita se estiver na topologia válida
                visited.add(v);
                parent.set(v, u);
                qBFS.push(v);
            }
        }
    }
    const orderBwd = [...orderFwd].reverse();

    // Mapa de Ramos
    const ramoIdx = {};
    linhasData.forEach(r => {
        ramoIdx[`${r.de}-${r.para}`] = r;
        ramoIdx[`${r.para}-${r.de}`] = r;
    });

    // --- Iteração Sweep ---
    const iterMax = 50;
    const tol = 1e-6;
    let conv = false;

    for (let it = 0; it < iterMax; it++) {
        const Iload = Array(nb + 1).fill(0).map(() => c(0, 0));
        
        // 1. Calcular Correntes de Carga (I = conj(S/V))
        for (const b of orderBwd) {
            if (sourceBuses.includes(b)) continue;
            if (cAbs(V[b]) > 1e-5) {
                Iload[b] = cConj(cDiv(S_inj[b], V[b]));
            }
        }

        const Iramo = {}; // Key: "u-v"
        const Isoma = Array(nb + 1).fill(0).map(() => c(0, 0)); // Acumulador nos nós

        // 2. Backward Sweep (Soma Correntes)
        for (const b of orderBwd) {
            if (sourceBuses.includes(b)) continue;
            const p = parent.get(b);
            if (p) {
                const i_flow = cAdd(Iload[b], Isoma[b]);
                Iramo[`${p}-${b}`] = i_flow;
                Isoma[p] = cAdd(Isoma[p], i_flow); // Passa corrente para o pai
            }
        }

        const V_ant = V.map(v => c(v.re, v.im));

        // 3. Forward Sweep (Queda de Tensão)
        for (const u of orderFwd) {
            for (const v of adj[u]) {
                if (parent.get(v) === u) { // Se v é filho de u
                    const r = ramoIdx[`${u}-${v}`];
                    const Zr = r ? c((r.R || 0) / Zbase, (r.X || 0) / Zbase) : c(0, 0);
                    const drop = cMul(Zr, Iramo[`${u}-${v}`] || c(0, 0));
                    V[v] = cSub(V[u], drop);
                }
            }
        }

        // Teste Convergência
        let maxDv = 0;
        for (let b = 1; b <= nb; b++) {
            if (topo.zones[b]) maxDv = Math.max(maxDv, cAbs(cSub(V[b], V_ant[b])));
        }
        if (maxDv < tol) {
            conv = true;
            break;
        }
    }

    // --- Resultados ---
    const resBarras = [];
    for (let b = 1; b <= nb; b++) {
        const z = topo.zones[b];
        resBarras.push({
            barra: b,
            zona: z, // Adiciona a zona identificada
            Vmag: z ? cAbs(V[b]) : 0,
            Vang: z ? angDeg(V[b]) : 0,
            isConnected: !!z
        });
    }

    const resRamos = [];
    // Para simplificar a visualização, não recalculamos P/Q/Perdas exatos no ramo aqui,
    // pois o foco é a topologia e tensão. O AG usa Vmag para fitness.
    linhasData.forEach(l => {
        resRamos.push({
            ...l,
            zona: topo.zones[l.de], // Zona do nó de origem
            perdasMW: 0, 
            Smva: 0
        });
    });

    return { resBarras, resRamos, perdasMWtotal: 0, unservedBuses: Array.from(topo.unserved), error: null };
}

// --- Cálculo de Fitness do Indivíduo ---
async function calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses) {
    const falhaSet = new Set(linhaFalhaKeys);
    
    // 1. Decodificar Cromossomo
    let activeLines = [];
    let custoChaves = 0;
    let numNA = 0;
    
    individual.forEach((gene, i) => {
        if (gene === 1 && allLines[i]) {
            const l = allLines[i];
            const k1 = `${l.de}-${l.para}`;
            const k2 = `${l.para}-${l.de}`;
            
            // Se não está em falha
            if (!falhaSet.has(k1) && !falhaSet.has(k2)) {
                activeLines.push(l);
                custoChaves += (l.custo || 0);
                if(l.isNA) numNA++;
            }
        }
    });

    let fitness = custoChaves;

    // Penalidade se usar muitas linhas novas (NA)
    if(numNA > maxNALinhas) {
        fitness += (numNA - maxNALinhas) * GA_PENALTIES.MAX_NA_VIOL;
    }

    // 2. Executar Fluxo Multi-Fonte
    const res = await runFluxo(activeLines, nb, Sbase, Vbase_kV, cargas, sourceBuses);

    // Se houver erro topológico crítico (Loop), aplica penalidade mortal
    if(res.error) {
        fitness += GA_PENALTIES.LOOP_ALIMENTADOR;
        return { fitness, data: { error: res.error } };
    }

    // 3. Penalidades Operacionais
    // Carga não atendida
    let unservedP = 0;
    res.unservedBuses.forEach(b => { 
        if(cargas[b]) unservedP += (cargas[b].P || 0); 
    });
    fitness += unservedP * GA_PENALTIES.UNSERVED_MW;

    // Violação de Tensão
    res.resBarras.forEach(b => {
        if(b.isConnected) {
            if(b.Vmag < vMin) fitness += (vMin - b.Vmag) * GA_PENALTIES.VOLTAGE_VIOL_PU;
            else if(b.Vmag > vMax) fitness += (b.Vmag - vMax) * GA_PENALTIES.VOLTAGE_VIOL_PU;
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

// --- Listener do Worker ---
self.onmessage = async (event) => {
    const { individual, index, staticData } = event.data;
    
    // Desempacota staticData incluindo as Fontes (sourceBuses)
    const { allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses } = staticData;

    try {
        const result = await calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, sourceBuses);
        self.postMessage({ index: index, result: result });
    } catch (error) {
        self.postMessage({ 
            index: index, 
            result: { fitness: Infinity }, 
            error: error.message 
        });
    }
};
