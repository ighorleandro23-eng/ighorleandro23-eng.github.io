// --- ga_worker.js ---

// --- Utilidades numéricas ---
function c(re=0,im=0){return{re,im}} function cAdd(a,b){return c(a.re+b.re,a.im+b.im)} function cSub(a,b){return c(a.re-b.re,a.im-b.im)} function cMul(a,b){return c(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re)} function cConj(a){return c(a.re,-a.im)} function cAbs(a){return Math.hypot(a.re,a.im)} function cDiv(a,b){const d=b.re*b.re+b.im*b.im||1e-30;return c((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d)} function pol2rec(m,d){const r=d*Math.PI/180;return c(m*Math.cos(r),m*Math.sin(r))} function angDeg(a){return Math.atan2(a.im,a.re)*180/Math.PI}

// --- Classe DSU ---
class DSU { constructor(n){this.parent=Array(n+1).fill(0).map((_,i)=>i);this.numSets=n}find(i){if(this.parent[i]===i)return i;return this.parent[i]=this.find(this.parent[i])}union(i,j){const rI=this.find(i);const rJ=this.find(j);if(rI!==rJ){this.parent[rI]=rJ;this.numSets--;return!0}return!1}}

// --- Constantes GA_PENALTIES ---
const GA_PENALTIES = {
    UNSERVED_MW: 50000,
    VOLTAGE_VIOL_PU: 10000,
    SMAX_VIOL_MVA: 5000,
    NOT_CONNECTED: 10000000,
    MAX_NA_VIOL: 100000000 // Penalidade por violar o limite de linhas NA
};

// --- Função validarRadial ---
function validarRadial(n,l){if(l.length===0){const u=new Set();for(let b=2;b<=n;b++)u.add(b);return{ok:n<=1,msg:n<=1?'OK':'Não conectado (sem linhas)',unservedBuses:u}} const adj=Array(n+1).fill(0).map(()=>[]);let hasLoopOrMultiParent = false; const q=[1],visited=new Set([1]),parent={}; let head = 0; for(const e of l){ if(!e || typeof e.de !== 'number' || typeof e.para !== 'number' || e.de < 1 || e.de > n || e.para < 1 || e.para > n) { console.warn("[Worker] Linha inválida em validarRadial:", e); continue; } if(e.para===1)return{ok:!1,msg:'Slack não pode ter entrada',unservedBuses:new Set()}; adj[e.de].push(e.para); } while(head < q.length){ const u=q[head++]; for(const v of adj[u]){ if(!v || v < 1 || v > n) { console.warn("[Worker] Índice v inválido em validarRadial:", v, "vindo de u:", u); continue; } if(visited.has(v)){ hasLoopOrMultiParent = true; break; } visited.add(v); parent[v]=u; q.push(v); } if(hasLoopOrMultiParent) break;} if(hasLoopOrMultiParent) return {ok:false, msg:'Loop ou barra multi-alimentada detectado.', unservedBuses: new Set()}; const connectedCount=visited.size, uB=new Set(); for(let b=1;b<=n;b++)if(!visited.has(b))uB.add(b); if(connectedCount<n)return{ok:!0,msg:`Parcialmente conectado. ${uB.size} isoladas.`,unservedBuses:uB}; return{ok:!0,msg:'Rede OK',unservedBuses:uB}}

// --- Função runFluxo (CORRIGIDA) ---
async function runFluxo(linhasData, nb, Sbase, Vbase_kV, cargas) {
    const tol = 1e-6; const iterMax = 100; let perdasMWtotal = 0; const orientedLinhas = []; const adj = Array(nb + 1).fill(0).map(() => []);
    if (!Array.isArray(linhasData)) { console.error("[Worker] runFluxo: linhasData não é array:", linhasData); const rBE = []; for(let b=1; b<=nb; b++) rBE.push({barra:b, Vmag:(b===1?1:0), Vang:0, Pmw:(cargas[b]?.P||0), Qmvar:(cargas[b]?.Q||0), isConnected:(b===1)}); const uE = new Set(); for(let b=2; b<=nb; b++) if(cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) uE.add(b); return { resBarras: rBE, resRamos: [], perdasMWtotal: 0, unservedBuses: uE }; }
    const validLinhasData = linhasData.filter(l => l && typeof l.de === 'number' && typeof l.para === 'number' && l.de >= 1 && l.de <= nb && l.para >= 1 && l.para <= nb);
     if (validLinhasData.length === 0 && nb > 1) { console.warn("[Worker] Nenhuma linha válida fornecida para runFluxo."); const rBE = []; for(let b=1; b<=nb; b++) rBE.push({barra:b, Vmag:(b===1?1:0), Vang:0, Pmw:(cargas[b]?.P||0), Qmvar:(cargas[b]?.Q||0), isConnected:(b===1)}); const uE = new Set(); for(let b=2; b<=nb; b++) if(cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) uE.add(b); return { resBarras: rBE, resRamos: [], perdasMWtotal: 0, unservedBuses: uE }; }
    validLinhasData.forEach(l => { adj[l.de].push(l.para); adj[l.para].push(l.de); });
    const parent = Array(nb + 1).fill(0); const q = [1]; const visited = Array(nb + 1).fill(false); visited[1] = true; const connectedBuses = new Set([1]); let head = 0;
    while(head < q.length) { const u = q[head++]; for (const v of adj[u]) { if (v >= 1 && v <= nb && !visited[v]) { visited[v] = true; parent[v] = u; connectedBuses.add(v); q.push(v); const l = validLinhasData.find(line => (line.de === u && line.para === v) || (line.de === v && line.para === u)); if (l) orientedLinhas.push({ ...l, de: u, para: v }); } } }
    
    // *** CORREÇÃO APLICADA AQUI ***
    const validationResult = validarRadial(nb, orientedLinhas);
    if (!validationResult.ok &&
        !validationResult.msg.includes('Parcialmente conectado') &&
        !validationResult.msg.includes('Não conectado') // Permite 'Não conectado (sem linhas)'
       ) {
         console.error("[Worker] Validação crítica falhou:", validationResult.msg, "Linhas:", orientedLinhas);
         throw new Error('Falha validação (erro crítico): ' + validationResult.msg);
    }
    const unservedBusesFromValidation = validationResult.unservedBuses;
    // *** FIM DA CORREÇÃO ***

    const Zbase = (Vbase_kV * Vbase_kV) / Sbase; const V = Array(nb + 1).fill(0).map(() => c(1, 0)); const S = Array(nb + 1).fill(0).map(() => c(0, 0)); for (let b = 2; b <= nb; b++) { if (connectedBuses.has(b) && cargas[b]) S[b] = c(parseFloat(cargas[b].P || 0) / Sbase, parseFloat(cargas[b].Q || 0) / Sbase); else S[b] = c(0, 0); }
     if (orientedLinhas.length === 0 && nb > 1) { const rBE=[]; for (let b=1; b<=nb; b++) rBE.push({ barra:b, Vmag:(b===1 ? 1:0), Vang:0, Pmw:(cargas[b]?.P||0), Qmvar:(cargas[b]?.Q||0), isConnected:(b===1) }); const uBE=new Set(unservedBusesFromValidation); for(let b=2; b<=nb; b++) if(!connectedBuses.has(b) && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) uBE.add(b); return { resBarras:rBE, resRamos:[], perdasMWtotal:0, unservedBuses:uBE }; }
    const ramos = orientedLinhas.map((e) => { const R = typeof e.R ==='number'&&isFinite(e.R)?e.R:0; const X = typeof e.X ==='number'&&isFinite(e.X)?e.X:0; const Zr = Zbase > 1e-9 ? R / Zbase : 0; const Zi = Zbase > 1e-9 ? X / Zbase : 0; return { idx:e.id, de:e.de, para:e.para, Z:c(Zr, Zi), Smax:e.Smax, isNA:e.isNA }; }); const adjFilhos = Array(nb + 1).fill(0).map(() => []); ramos.forEach(r => adjFilhos[r.de].push(r.para)); const depth = Array(nb + 1).fill(0); const orderFwd = []; const orderBwd = []; { const qFwd = [1]; depth[1] = 0; const visitedOrder = new Set([1]); let headFwd = 0; while (headFwd < qFwd.length) { const u = qFwd[headFwd++]; orderFwd.push(u); adjFilhos[u].forEach(v => { if (v >= 1 && v <= nb && !visitedOrder.has(v)) { depth[v] = depth[u] + 1; qFwd.push(v); visitedOrder.add(v); } }); } const nodes = []; visitedOrder.forEach(b => { if (b !== 1) nodes.push(b); }); nodes.sort((a, b) => depth[b] - depth[a]); orderBwd.push(...nodes); } const ramoIdx = {}; ramos.forEach(r => { ramoIdx[`${r.de}-${r.para}`] = r; }); let conv = false; let V_ant = V.map(v => c(v.re, v.im));
    for (let it = 0; it < iterMax; it++) { /* await new Promise(r => setTimeout(r, 0)); // No need in worker */ const Iload = Array(nb + 1).fill(0).map(() => c(0, 0)); for (let b = 2; b <= nb; b++) { if(connectedBuses.has(b)){ const S_b = S[b]; if (cAbs(V[b]) > 1e-9 && (Math.abs(S_b.re) + Math.abs(S_b.im) > 0)) Iload[b] = cConj(cDiv(S_b, V[b])); else Iload[b] = c(0, 0); } else Iload[b] = c(0,0); } const Iramo = {}; const Idow = Array(nb + 1).fill(0).map(() => c(0, 0)); for (const b of orderBwd) { const curr = cAdd(Iload[b], Idow[b]); const p = parent[b]; if (p > 0 && p <= nb) { Iramo[`${p}-${b}`] = curr; Idow[p] = cAdd(Idow[p], curr); } } V_ant = V.map(v => c(v.re, v.im)); V[1] = c(1, 0); for(let b=2; b<=nb; b++) if(!connectedBuses.has(b)) V[b] = c(0,0); for (const u of orderFwd) { for (const v of adjFilhos[u]) { const r = ramoIdx[`${u}-${v}`]; if (r) { const Ir = Iramo[`${u}-${v}`] || c(0, 0); const Z_val = r.Z || c(0,0); V[v] = cSub(V[u], cMul(Z_val, Ir)); } } } let maxDv = 0; for(const b of connectedBuses) maxDv = Math.max(maxDv, cAbs(cSub(V[b], V_ant[b]))); if (maxDv < tol) { conv = true; break; } }
    const resBarras = []; for (let b = 1; b <= nb; b++) { const isC = connectedBuses.has(b); const Vm = isC ? cAbs(V[b]) : 0; const Va = isC ? angDeg(V[b]) : 0; const Pmw = (cargas[b]?.P || 0); const Qmvar = (cargas[b]?.Q || 0); resBarras.push({ barra: b, Vmag: Vm, Vang: Va, Pmw, Qmvar, isConnected: isC }); } const IloadFinal = Array(nb + 1).fill(0).map(() => c(0, 0)); for (let b = 2; b <= nb; b++) { if (connectedBuses.has(b)) { const S_b = S[b]; if (cAbs(V[b]) > 1e-9 && (Math.abs(S_b.re) + Math.abs(S_b.im) > 0)) IloadFinal[b] = cConj(cDiv(S_b, V[b])); else IloadFinal[b] = c(0,0); } else IloadFinal[b] = c(0,0); } const IdowFinal = Array(nb + 1).fill(0).map(() => c(0, 0)); const IramoFinal = {}; for (const b of orderBwd) { const curr = cAdd(IloadFinal[b], IdowFinal[b]); const p = parent[b]; if (p > 0 && p <= nb) { IramoFinal[`${p}-${b}`] = curr; IdowFinal[p] = cAdd(IdowFinal[p], curr); } } const resRamos = []; perdasMWtotal = 0; for (const r of ramos) { const i = IramoFinal[`${r.de}-${r.para}`] || c(0, 0); const Vde = connectedBuses.has(r.de) ? V[r.de] : c(0,0); const Sij = cMul(Vde, cConj(i)); const Pmw = Sij.re * Sbase; const Qmvar = Sij.im * Sbase; const Smva = cAbs(Sij) * Sbase; const Zr = r.Z?.re || 0; const pMW = cAbs(i) * cAbs(i) * Zr * Sbase; if (isFinite(pMW)) perdasMWtotal += pMW; else console.warn(`[Worker] Perdas inválida (final) ${r.de}-${r.para}`); resRamos.push({ idx: r.idx, de: r.de, para: r.para, Pmw, Qmvar, Smva, Smax: r.Smax, perdasMW: isFinite(pMW)? pMW : 0, isNA: r.isNA }); } const finalUnserved = new Set(unservedBusesFromValidation); for(let b=2; b<=nb; b++) if(!connectedBuses.has(b) && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) finalUnserved.add(b); if (!isFinite(perdasMWtotal)) { console.warn("[Worker] perdasMWtotal NaN/Inf, zerando..."); perdasMWtotal = 0; }
    return { resBarras, resRamos, perdasMWtotal, unservedBuses: Array.from(finalUnserved) }; // Retorna Set como Array
}

// --- Função calculateSpecificFitness ---
async function calculateSpecificFitness(topologyLines, nb, vMin, vMax, cargas, Sbase, Vbase_kV, maxNALinhas) {
    let fitness = 0, unservedLoadP = 0, totalPerdasMW = 0;
    let resBarras = [], resRamos = [];
    
    // --- NOVO CÁLCULO DE CUSTO E CONTAGEM NA ---
    let custoChavesTotal = 0;
    let numNA_Usadas = 0;
    let numChavesAtivas = topologyLines.length;

    topologyLines.forEach(l => {
        custoChavesTotal += (l.custo || 0); // Usa o custo individual
        if (l.isNA === true) { // Verifica a flag
            numNA_Usadas++;
        }
    });

    fitness += custoChavesTotal; // Adiciona o custo de investimento

    // Penaliza se o AG usou mais NAs do que o permitido
    if (numNA_Usadas > maxNALinhas) {
        fitness += (numNA_Usadas - maxNALinhas) * GA_PENALTIES.MAX_NA_VIOL;
    }
    // --- FIM DO NOVO CÁLCULO ---

    const requiredBuses = new Set([1]); for(let b=2; b<=nb; b++) if(cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) requiredBuses.add(b);
    
    // REMOVIDA A LINHA: fitness += numActiveSwitches * pesoChave;

    try {
        const validationReduced = validarRadial(nb, topologyLines);
        if (!validationReduced.ok && !validationReduced.msg.includes('Parcialmente conectado')) {
             fitness = 1e11; unservedLoadP = 0;
             validationReduced.unservedBuses.forEach(b => { if(requiredBuses.has(b)) unservedLoadP += (cargas[b]?.P || 0); });
             fitness += unservedLoadP * GA_PENALTIES.UNSERVED_MW;
             console.warn(`[Worker] Validação crítica (corte): ${validationReduced.msg}`);
             return { fitness, unservedLoadP, totalPerdasMW: 0, resBarras: [], resRamos: [], custoChaves: custoChavesTotal, numChavesAtivas: numChavesAtivas, numNA_Usadas: numNA_Usadas };
        }
        const fluxoResult = await runFluxo(topologyLines, nb, Sbase, Vbase_kV, cargas);
        resBarras = fluxoResult.resBarras; resRamos = fluxoResult.resRamos;
        totalPerdasMW = (typeof fluxoResult.perdasMWtotal === 'number' && isFinite(fluxoResult.perdasMWtotal)) ? fluxoResult.perdasMWtotal : 0;
        unservedLoadP = 0;
        if(Array.isArray(fluxoResult.unservedBuses)) {
            fluxoResult.unservedBuses.forEach(b => { if (b !== 1 && cargas[b]) unservedLoadP += (cargas[b].P || 0); });
        } else {
             console.warn("[Worker] unservedBuses não é array:", fluxoResult.unservedBuses);
             if(validationReduced.unservedBuses) validationReduced.unservedBuses.forEach(b => { if (b !== 1 && cargas[b]) unservedLoadP += (cargas[b].P || 0); });
        }
        fitness += unservedLoadP * GA_PENALTIES.UNSERVED_MW;
        resBarras.forEach(b => { if (b.isConnected) { if ((b.Vmag ?? 0) < vMin) fitness += (vMin - (b.Vmag ?? 0)) * GA_PENALTIES.VOLTAGE_VIOL_PU; else if ((b.Vmag ?? 0) > vMax) fitness += ((b.Vmag ?? 0) - vMax) * GA_PENALTIES.VOLTAGE_VIOL_PU; } else if (requiredBuses.has(b.barra)) fitness += GA_PENALTIES.UNSERVED_MW * (cargas[b.barra]?.P || 0); });
        resRamos.forEach(r => { const smax = (r.Smax ?? 1) > 1e-9 ? r.Smax : 1; if ((r.Smva ?? 0) > smax) fitness += ((r.Smva ?? 0) - smax) * GA_PENALTIES.SMAX_VIOL_MVA; });
        fitness += totalPerdasMW;
    } catch (error) {
         fitness = 1e11; console.warn(`[Worker] Erro fluxo (corte): ${error.message}`);
         unservedLoadP = 0; for(let b=2; b<=nb; b++) if(requiredBuses.has(b)) unservedLoadP += (cargas[b]?.P || 0);
         fitness += unservedLoadP * GA_PENALTIES.UNSERVED_MW; totalPerdasMW = 0;
    }
     if (!isFinite(fitness)) fitness = 1e15;
    return { fitness, unservedLoadP, totalPerdasMW, resBarras, resRamos, custoChaves: custoChavesTotal, numChavesAtivas: numChavesAtivas, numNA_Usadas: numNA_Usadas };
}

// --- Função calculateFitness ---
async function calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV) {
    let fitness = 0, custoChaves = 0, numChavesAtivas = 0, unservedLoadP = 0, totalPerdasMW = 0;
    const falhaSet = new Set(linhaFalhaKeys);
    let candidateLines = []; individual.forEach((gene, i) => { if (gene === 1 && allLines[i]) { const l = allLines[i]; const k1 = `${l.de}-${l.para}`, k2 = `${l.para}-${l.de}`; if (!falhaSet.has(k1) && !falhaSet.has(k2)) candidateLines.push(l); } }); candidateLines.sort((a, b) => (a.Z || Infinity) - (b.Z || Infinity));
    const dsu = new DSU(nb); const mstLines = []; for (const line of candidateLines) { if (line.de >= 1 && line.de <= nb && line.para >= 1 && line.para <= nb && dsu.union(line.de, line.para)) mstLines.push(line); /* Otimização: não para em N-1, pois pode precisar de mais linhas se algumas barras não forem alcançáveis */ }
    
    // Custo é calculado dentro de calculateSpecificFitness agora
    
    let bestFitness = Infinity;
    let bestData = { unservedLoadP: 9999, totalPerdasMW: 9999, numChavesAtivas: 0, custoChaves: 0, numNA_Usadas: 0, resBarras: [], resRamos: [], currentLinhas: [] };

    // 1. Avalia a solução MST completa
    const baseResult = await calculateSpecificFitness(mstLines, nb, vMin, vMax, cargas, Sbase, Vbase_kV, maxNALinhas);
    bestFitness = baseResult.fitness;
    bestData = { ...baseResult, currentLinhas: mstLines };
    
    // 2. Simula o corte de folhas (apenas se a rede base conectou algo)
    if (mstLines.length > 0) {
        const degreeCount = {}; mstLines.forEach(l => { degreeCount[l.de] = (degreeCount[l.de] || 0) + 1; degreeCount[l.para] = (degreeCount[l.para] || 0) + 1; });
        const leaves = []; for (let b = 2; b <= nb; b++) { if (degreeCount[b] === 1 && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) leaves.push(b); }

        for (const leafNode of leaves) {
            const lineToRemove = mstLines.find(l => l.de === leafNode || l.para === leafNode);
            if (lineToRemove) {
                const reducedLines = mstLines.filter(l => l !== lineToRemove);
                
                // Custo é recalculado dentro da função
                const cargaCortadaP = cargas[leafNode]?.P || 0;
                const penalidadeCorte = (cargaCortadaP > 0) ? (cargaCortadaP * GA_PENALTIES.UNSERVED_MW) : 0;
                
                // Pré-verificação simples (pode não ser 100% precisa, mas ajuda)
                // Se a penalidade de corte sozinha já é pior, pula.
                if (penalidadeCorte >= bestFitness) {
                    continue; 
                }

                const reducedResult = await calculateSpecificFitness(reducedLines, nb, vMin, vMax, cargas, Sbase, Vbase_kV, maxNALinhas);
                 let fitnessSimulado = reducedResult.fitness;
                 fitnessSimulado += penalidadeCorte; // Adiciona penalidade pela carga cortada manualmente

                if (fitnessSimulado < bestFitness) {
                    bestFitness = fitnessSimulado;
                    bestData = {
                        ...reducedResult, // Pega todos os dados (custo, chaves, NA, etc.)
                        unservedLoadP: reducedResult.unservedLoadP + cargaCortadaP, // Soma a carga cortada
                        currentLinhas: reducedLines
                    };
                }
            }
        }
    }
    if (!isFinite(bestFitness)) bestFitness = 1e15;
    
    if(bestData.resBarras && bestData.resBarras.length > 0){
         const finalConnected = new Set();
         bestData.resBarras.forEach(b => { if(b.isConnected) finalConnected.add(b.barra); });
         const finalUnservedSet = new Set();
         for(let b=1; b<=nb; b++) if(!finalConnected.has(b)) finalUnservedSet.add(b);
         bestData.unservedBuses = Array.from(finalUnservedSet);
    } else {
         const finalDSU = new DSU(nb);
         if(Array.isArray(bestData.currentLinhas)) bestData.currentLinhas.forEach(l => finalDSU.union(l.de, l.para));
         const finalRoot = finalDSU.find(1);
         const finalUnservedSet = new Set();
         for(let b=1; b<=nb; b++) if(finalDSU.find(b) !== finalRoot) finalUnservedSet.add(b);
         bestData.unservedBuses = Array.from(finalUnservedSet);
    }

    return { fitness: bestFitness, data: bestData };
}

// --- Listener Principal do Worker ---
self.onmessage = async (event) => {
    const { individual, index, staticData } = event.data;
    // --- ADICIONE ESTA LINHA ---
    console.log(`[Worker] Avaliando Indivíduo ${index}, Genes:`, individual);
    // ---------------------------
    // Desempacota staticData com os novos parâmetros
    const { allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV } = staticData;

    try {
        // *** CORREÇÃO APLICADA AQUI ***
        // Passa maxNALinhas para a função
        // Garante que Vbase_kV está correto (sem "VV")
        const result = await calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV);
        self.postMessage({ index: index, result: result });
    } catch (error) {
        console.error(`[Worker] Erro fatal indivíduo ${index}:`, error);
        self.postMessage({
            index: index,
            result: {
                fitness: Infinity,
                data: { unservedLoadP: 9999, totalPerdasMW: 9999, numChavesAtivas: 0, custoChaves: 0, numNA_Usadas: 0, resBarras: [], resRamos: [], currentLinhas: [] }
            },
            error: error.message
        });
    }
};

