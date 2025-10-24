// --- ga_worker.js ---

// ... (Utilidades numéricas c(), cAdd(), DSU(), GA_PENALTIES ... idênticas) ...

// --- MUDANÇA: validarRadial aceita slackBusId ---
function validarRadial(n, l, slackBusId = 1){
    if(l.length===0){const u=new Set();for(let b=1;b<=n;b++) if(b !== slackBusId) u.add(b);return{ok:n<=1,msg:n<=1?'OK':'Não conectado (sem linhas)',unservedBuses:u}} const adj=Array(n+1).fill(0).map(()=>[]);let hasLoopOrMultiParent = false; const q=[slackBusId],visited=new Set([slackBusId]),parent={};
let head = 0; for(const e of l){ if(!e || typeof e.de !== 'number' || typeof e.para !== 'number' || e.de < 1 || e.de > n || e.para < 1 || e.para > n) { console.warn("[Worker] Linha inválida em validarRadial:", e);
continue; } if(e.para===slackBusId)return{ok:!1,msg:`Fonte (Barra ${slackBusId}) não pode ter entrada`,unservedBuses:new Set()}; adj[e.de].push(e.para); } while(head < q.length){ const u=q[head++];
for(const v of adj[u]){ if(!v || v < 1 || v > n) { console.warn("[Worker] Índice v inválido em validarRadial:", v, "vindo de u:", u);
continue; } if(visited.has(v)){ hasLoopOrMultiParent = true; break; } visited.add(v); parent[v]=u; q.push(v);
} if(hasLoopOrMultiParent) break;} if(hasLoopOrMultiParent) return {ok:false, msg:'Loop ou barra multi-alimentada detectado.', unservedBuses: new Set()}; const connectedCount=visited.size, uB=new Set(); for(let b=1;b<=n;b++)if(!visited.has(b))uB.add(b);
if(connectedCount<n)return{ok:!0,msg:`Parcialmente conectado. ${uB.size} isoladas.`,unservedBuses:uB}; return{ok:!0,msg:'Rede OK',unservedBuses:uB}}

// --- MUDANÇA: runFluxo aceita slackBusId ---
async function runFluxo(linhasData, nb, Sbase, Vbase_kV, cargas, slackBusId = 1) {
    const tol = 1e-6;
const iterMax = 100; let perdasMWtotal = 0; const orientedLinhas = []; const adj = Array(nb + 1).fill(0).map(() => []);
if (!Array.isArray(linhasData)) { console.error("[Worker] runFluxo: linhasData não é array:", linhasData); const rBE = [];
for(let b=1; b<=nb; b++) rBE.push({barra:b, Vmag:(b===slackBusId?1:0), Vang:0, Pmw:(cargas[b]?.P||0), Qmvar:(cargas[b]?.Q||0), isConnected:(b===slackBusId)}); const uE = new Set();
for(let b=1; b<=nb; b++) if(b !== slackBusId && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) uE.add(b);
return { resBarras: rBE, resRamos: [], perdasMWtotal: 0, unservedBuses: uE };
}
    const validLinhasData = linhasData.filter(l => l && typeof l.de === 'number' && typeof l.para === 'number' && l.de >= 1 && l.de <= nb && l.para >= 1 && l.para <= nb);
if (validLinhasData.length === 0 && nb > 1) { console.warn("[Worker] Nenhuma linha válida fornecida para runFluxo."); const rBE = [];
for(let b=1; b<=nb; b++) rBE.push({barra:b, Vmag:(b===slackBusId?1:0), Vang:0, Pmw:(cargas[b]?.P||0), Qmvar:(cargas[b]?.Q||0), isConnected:(b===slackBusId)}); const uE = new Set();
for(let b=1; b<=nb; b++) if(b !== slackBusId && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) uE.add(b);
return { resBarras: rBE, resRamos: [], perdasMWtotal: 0, unservedBuses: uE };
}
    validLinhasData.forEach(l => { adj[l.de].push(l.para); adj[l.para].push(l.de); });
    const parent = Array(nb + 1).fill(0); const q = [slackBusId];
const visited = Array(nb + 1).fill(false); visited[slackBusId] = true; const connectedBuses = new Set([slackBusId]); let head = 0;
while(head < q.length) { const u = q[head++]; for (const v of adj[u]) { if (v >= 1 && v <= nb && !visited[v]) { visited[v] = true;
parent[v] = u; connectedBuses.add(v); q.push(v); const l = validLinhasData.find(line => (line.de === u && line.para === v) || (line.de === v && line.para === u));
if (l) orientedLinhas.push({ ...l, de: u, para: v }); } } }
    
    // *** MUDANÇA: Passa o slackBusId ***
    const validationResult = validarRadial(nb, orientedLinhas, slackBusId);
if (!validationResult.ok &&
        !validationResult.msg.includes('Parcialmente conectado') &&
        !validationResult.msg.includes('Não conectado')
       ) {
         console.error("[Worker] Validação crítica falhou:", validationResult.msg, "Linhas:", orientedLinhas);
throw new Error('Falha validação (erro crítico): ' + validationResult.msg);
    }
    const unservedBusesFromValidation = validationResult.unservedBuses;
const Zbase = (Vbase_kV * Vbase_kV) / Sbase;
const V = Array(nb + 1).fill(0).map(() => c(1, 0)); const S = Array(nb + 1).fill(0).map(() => c(0, 0));
    
    // *** MUDANÇA: Loop ignora o slackBusId atual ***
for (let b = 1; b <= nb; b++) {
        if (b === slackBusId) continue; // Fontes não são cargas
        if (connectedBuses.has(b) && cargas[b]) S[b] = c(parseFloat(cargas[b].P || 0) / Sbase, parseFloat(cargas[b].Q || 0) / Sbase);
else S[b] = c(0, 0); }
    
     if (orientedLinhas.length === 0 && nb > 1) { const rBE=[];
for (let b=1; b<=nb; b++) rBE.push({ barra:b, Vmag:(b===slackBusId ? 1:0), Vang:0, Pmw:(cargas[b]?.P||0), Qmvar:(cargas[b]?.Q||0), isConnected:(b===slackBusId) }); const uBE=new Set(unservedBusesFromValidation);
for(let b=1; b<=nb; b++) if(b !== slackBusId && !connectedBuses.has(b) && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) uBE.add(b);
return { resBarras:rBE, resRamos:[], perdasMWtotal:0, unservedBuses:uBE }; }
    
const ramos = orientedLinhas.map((e) => { const R = typeof e.R ==='number'&&isFinite(e.R)?e.R:0; const X = typeof e.X ==='number'&&isFinite(e.X)?e.X:0; const Zr = Zbase > 1e-9 ? R / Zbase : 0; const Zi = Zbase > 1e-9 ? X / Zbase : 0; return { idx:e.id, de:e.de, para:e.para, Z:c(Zr, Zi), Smax:e.Smax, isNA:e.isNA }; });
const adjFilhos = Array(nb + 1).fill(0).map(() => []); ramos.forEach(r => adjFilhos[r.de].push(r.para)); const depth = Array(nb + 1).fill(0);
const orderFwd = []; const orderBwd = []; { const qFwd = [slackBusId]; depth[slackBusId] = 0;
const visitedOrder = new Set([slackBusId]); let headFwd = 0; while (headFwd < qFwd.length) { const u = qFwd[headFwd++]; orderFwd.push(u);
adjFilhos[u].forEach(v => { if (v >= 1 && v <= nb && !visitedOrder.has(v)) { depth[v] = depth[u] + 1; qFwd.push(v); visitedOrder.add(v); } });
} const nodes = []; visitedOrder.forEach(b => { if (b !== slackBusId) nodes.push(b); }); nodes.sort((a, b) => depth[b] - depth[a]);
orderBwd.push(...nodes); } const ramoIdx = {}; ramos.forEach(r => { ramoIdx[`${r.de}-${r.para}`] = r; }); let conv = false;
let V_ant = V.map(v => c(v.re, v.im));
    for (let it = 0; it < iterMax; it++) {
const Iload = Array(nb + 1).fill(0).map(() => c(0, 0));
        
        // *** MUDANÇA: Loop ignora o slackBusId atual ***
for (let b = 1; b <= nb; b++) {
            if (b === slackBusId) continue;
            if(connectedBuses.has(b)){ const S_b = S[b];
if (cAbs(V[b]) > 1e-9 && (Math.abs(S_b.re) + Math.abs(S_b.im) > 0)) Iload[b] = cConj(cDiv(S_b, V[b])); else Iload[b] = c(0, 0);
} else Iload[b] = c(0,0); } 
        
        const Iramo = {}; const Idow = Array(nb + 1).fill(0).map(() => c(0, 0));
for (const b of orderBwd) { const curr = cAdd(Iload[b], Idow[b]); const p = parent[b];
if (p > 0 && p <= nb) { Iramo[`${p}-${b}`] = curr; Idow[p] = cAdd(Idow[p], curr);
} } V_ant = V.map(v => c(v.re, v.im)); V[slackBusId] = c(1, 0); for(let b=1; b<=nb; b++) if(!connectedBuses.has(b)) V[b] = c(0,0);
for (const u of orderFwd) { for (const v of adjFilhos[u]) { const r = ramoIdx[`${u}-${v}`];
if (r) { const Ir = Iramo[`${u}-${v}`] || c(0, 0); const Z_val = r.Z || c(0,0);
V[v] = cSub(V[u], cMul(Z_val, Ir)); } } } let maxDv = 0;
for(const b of connectedBuses) maxDv = Math.max(maxDv, cAbs(cSub(V[b], V_ant[b]))); if (maxDv < tol) { conv = true; break;
} }
    
    // *** MUDANÇA: Precisa saber de TODAS as fontes para Pmw/Qmvar ***
    // Esta informação não está aqui. A lógica de P/Q será tratada em calculateSpecificFitness
    const resBarras = []; for (let b = 1; b <= nb; b++) { const isC = connectedBuses.has(b);
const Vm = isC ? cAbs(V[b]) : 0; const Va = isC ? angDeg(V[b]) : 0;
const Pmw = (cargas[b]?.P || 0); // P/Q genérico, será corrigido depois
const Qmvar = (cargas[b]?.Q || 0);
        resBarras.push({ barra: b, Vmag: Vm, Vang: Va, Pmw, Qmvar, isConnected: isC });
} const IloadFinal = Array(nb + 1).fill(0).map(() => c(0, 0));
    
    // *** MUDANÇA: Loop ignora o slackBusId atual ***
for (let b = 1; b <= nb; b++) {
        if (b === slackBusId) continue;
        if (connectedBuses.has(b)) { const S_b = S[b];
if (cAbs(V[b]) > 1e-9 && (Math.abs(S_b.re) + Math.abs(S_b.im) > 0)) IloadFinal[b] = cConj(cDiv(S_b, V[b])); else IloadFinal[b] = c(0,0);
} else IloadFinal[b] = c(0,0); } 
    
    const IdowFinal = Array(nb + 1).fill(0).map(() => c(0, 0)); const IramoFinal = {};
for (const b of orderBwd) { const curr = cAdd(IloadFinal[b], IdowFinal[b]); const p = parent[b];
if (p > 0 && p <= nb) { IramoFinal[`${p}-${b}`] = curr; IdowFinal[p] = cAdd(IdowFinal[p], curr);
} } const resRamos = []; perdasMWtotal = 0; for (const r of ramos) { const i = IramoFinal[`${r.de}-${r.para}`] ||
c(0, 0); const Vde = connectedBuses.has(r.de) ? V[r.de] : c(0,0); const Sij = cMul(Vde, cConj(i));
const Pmw = Sij.re * Sbase; const Qmvar = Sij.im * Sbase; const Smva = cAbs(Sij) * Sbase;
const Zr = r.Z?.re || 0; const pMW = cAbs(i) * cAbs(i) * Zr * Sbase;
if (isFinite(pMW)) perdasMWtotal += pMW; else console.warn(`[Worker] Perdas inválida (final) ${r.de}-${r.para}`);
resRamos.push({ idx: r.idx, de: r.de, para: r.para, Pmw, Qmvar, Smva, Smax: r.Smax, perdasMW: isFinite(pMW)? pMW : 0, isNA: r.isNA });
} const finalUnserved = new Set(unservedBusesFromValidation);
    for(let b=1; b<=nb; b++) {
        if(b !== slackBusId && !connectedBuses.has(b) && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) finalUnserved.add(b);
    }
if (!isFinite(perdasMWtotal)) { console.warn("[Worker] perdasMWtotal NaN/Inf, zerando..."); perdasMWtotal = 0;
}
    return { resBarras, resRamos, perdasMWtotal, unservedBuses: Array.from(finalUnserved) };
}
// *** FIM DA MUDANÇA ***


// --- MUDANÇA: calculateSpecificFitness (reescrito para "dividir para conquistar") ---
async function calculateSpecificFitness(topologyLines, nb, vMin, vMax, cargas, Sbase, Vbase_kV, maxNALinhas, substationBuses, isNormalOperation) {
    let fitness = 0;
    let totalPerdasMW = 0;
    let unservedLoadP = 0;
    
let custoChavesTotal = 0;
let numNA_Usadas = 0;
    let numChavesAtivas = topologyLines.length;

    topologyLines.forEach(l => {
        custoChavesTotal += (l.custo || 0);
        if (l.isNA === true) numNA_Usadas++;
    });
fitness += custoChavesTotal;

    if (numNA_Usadas > maxNALinhas) {
        fitness += (numNA_Usadas - maxNALinhas) * GA_PENALTIES.MAX_NA_VIOL;
}

    const requiredBuses = new Set(substationBuses);
for(let b=1; b<=nb; b++) if(!substationBuses.includes(b) && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) requiredBuses.add(b);

    // --- NOVA LÓGICA DE PENALIZAÇÃO DE CONEXÃO DE FONTES ---
    // (Também verifica se alguma fonte está isolada da própria rede)
    const dsu_fluxo = new DSU(nb);
    topologyLines.forEach(l => dsu_fluxo.union(l.de, l.para));
    
    const sourceRoots = substationBuses.map(b => dsu_fluxo.find(b));
    const uniqueRoots = new Set(sourceRoots);

    if (uniqueRoots.size < sourceRoots.length) {
        // Se o tamanho do Set é menor, significa que duas fontes têm a mesma raiz
        // (Ex: find(1) === find(20)), então elas foram conectadas.
        fitness += 1e12; // Penalidade GIGANTE por conectar fontes
        console.warn("[Worker] Penalidade: Fontes conectadas. Fitness = 1e12.");
        // Retorna cedo, esta solução é inválida
        return { fitness, unservedLoadP: 9999, totalPerdasMW: 9999, resBarras: [], resRamos: [], custoChaves: custoChavesTotal, numChavesAtivas: numChavesAtivas, numNA_Usadas: numNA_Usadas };
    }
    // --- FIM DA NOVA LÓGICA ---

    let allResBarras = new Array(nb + 1);
    let allResRamos = [];
    const connectedBusSet = new Set();
    let hasFluxError = false;

    try {
        // --- NOVA LÓGICA: LOOP "DIVIDIR PARA CONQUISTAR" ---
        for (const sourceId of substationBuses) {
            const root = dsu_fluxo.find(sourceId);
            
            // Filtra as linhas que pertencem a esta "ilha" da fonte
            const minhasLinhas = topologyLines.filter(l => dsu_fluxo.find(l.de) === root);

            if (minhasLinhas.length === 0) {
                 // Fonte está isolada, mas ela existe
                 allResBarras[sourceId] = { barra: sourceId, Vmag: 1.0, Vang: 0, Pmw: 0, Qmvar: 0, isConnected: true };
                 connectedBusSet.add(sourceId);
                 continue;
            }
            
            // Chama o motor de fluxo modificado
            const { resBarras, resRamos, perdasMWtotal, unservedBuses } = await runFluxo(minhasLinhas, nb, Sbase, Vbase_kV, cargas, sourceId);
            
            totalPerdasMW += perdasMWtotal;

            // Combina os resultados
            resBarras.forEach(b => {
                if (b.isConnected) {
                    allResBarras[b.barra] = b; // Salva o resultado da barra
                    connectedBusSet.add(b.barra);
                }
            });
            allResRamos.push(...resRamos);
        }
        // --- FIM DO LOOP ---

        // Preenche barras que não foram conectadas por nenhum fluxo
        const finalBarras = [];
        for (let b = 1; b <= nb; b++) {
            if (allResBarras[b]) {
                // Barra foi processada
                const bData = allResBarras[b];
                // Corrige P/Q (carga é 0 se for *qualquer* fonte)
                bData.Pmw = (substationBuses.includes(b) ? 0 : (cargas[b]?.P || 0));
                bData.Qmvar = (substationBuses.includes(b) ? 0 : (cargas[b]?.Q || 0));
                finalBarras.push(bData);
            } else {
                // Barra não foi conectada a NENHUMA fonte
                finalBarras.push({ barra: b, Vmag: 0, Vang: 0, Pmw: (cargas[b]?.P || 0), Qmvar: (cargas[b]?.Q || 0), isConnected: false });
            }
        }
        
        // Agora aplicamos penalidades no resultado global
        unservedLoadP = 0;
        finalBarras.forEach(b => {
            if (b.isConnected) {
                // Penalidade de Tensão
                if ((b.Vmag ?? 0) < vMin) fitness += (vMin - (b.Vmag ?? 0)) * GA_PENALTIES.VOLTAGE_VIOL_PU;
                else if ((b.Vmag ?? 0) > vMax) fitness += ((b.Vmag ?? 0) - vMax) * GA_PENALTIES.VOLTAGE_VIOL_PU;
            } else {
                // Penalidade de Carga Não Atendida
                if (requiredBuses.has(b.barra)) {
                    unservedLoadP += (cargas[b.barra]?.P || 0);
                }
            }
        });
        
        allResRamos.forEach(r => {
            // Penalidade de Sobrecarga
            const smax = (r.Smax ?? 1) > 1e-9 ? r.Smax : 1;
            if ((r.Smva ?? 0) > smax) fitness += ((r.Smva ?? 0) - smax) * GA_PENALTIES.SMAX_VIOL_MVA;
        });

        fitness += unservedLoadP * GA_PENALTIES.UNSERVED_MW;
        fitness += totalPerdasMW;
        
        resBarras = finalBarras; // Salva os resultados globais
        resRamos = allResRamos;

    } catch (error) {
        hasFluxError = true;
        console.warn(`[Worker] Erro fluxo (corte): ${error.message}`);
    }

    if (hasFluxError || !isFinite(fitness)) {
        fitness = 1e15;
        unservedLoadP = 0;
        for(let b=1; b<=nb; b++) {
            if (requiredBuses.has(b) && !substationBuses.includes(b)) {
                 unservedLoadP += (cargas[b]?.P || 0);
            }
        }
        fitness += unservedLoadP * GA_PENALTIES.UNSERVED_MW;
        totalPerdasMW = 0;
    }
    
    return { fitness, unservedLoadP, totalPerdasMW, resBarras, resRamos, custoChaves: custoChavesTotal, numChavesAtivas: numChavesAtivas, numNA_Usadas: numNA_Usadas };
}
// --- FIM DA REESCRITA ---


// --- MUDANÇA: calculateFitness (passa parâmetros e atualiza fallback DSU) ---
async function calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, substationBuses) {
    let fitness = 0, custoChaves = 0, numChavesAtivas = 0, unservedLoadP = 0, totalPerdasMW = 0;
const falhaSet = new Set(linhaFalhaKeys);
    
    // Filtro de Linhas (igual a antes [cite: 514])
    let candidateLines = []; individual.forEach((gene, i) => { if (gene === 1 && allLines[i]) { const l = allLines[i]; const k1 = `${l.de}-${l.para}`, k2 = `${l.para}-${l.de}`; if (!falhaSet.has(k1) && !falhaSet.has(k2)) candidateLines.push(l); } });
    
    // Lógica DSU/Kruskal (igual a antes )
candidateLines.sort((a, b) => (a.Z || Infinity) - (b.Z || Infinity));
    const dsu = new DSU(nb); const mstLines = [];
for (const line of candidateLines) { if (line.de >= 1 && line.de <= nb && line.para >= 1 && line.para <= nb && dsu.union(line.de, line.para)) mstLines.push(line);
}
    
let bestFitness = Infinity;
let bestData = { unservedLoadP: 9999, totalPerdasMW: 9999, numChavesAtivas: 0, custoChaves: 0, numNA_Usadas: 0, resBarras: [], resRamos: [], currentLinhas: [] };
    
    // *** MUDANÇA: Passa novos parâmetros ***
    const isNormalOp = linhaFalhaKeys.length === 0;

const baseResult = await calculateSpecificFitness(mstLines, nb, vMin, vMax, cargas, Sbase, Vbase_kV, maxNALinhas, substationBuses, isNormalOp);
bestFitness = baseResult.fitness;
    bestData = { ...baseResult, currentLinhas: mstLines };

    // Lógica de "Corte Opcional" (igual a antes [cite: 521-524])
    if (mstLines.length > 0) {
const degreeCount = {};
        mstLines.forEach(l => { degreeCount[l.de] = (degreeCount[l.de] || 0) + 1; degreeCount[l.para] = (degreeCount[l.para] || 0) + 1; });
const leaves = []; for (let b = 1; b <= nb; b++) { if (!substationBuses.includes(b) && degreeCount[b] === 1 && cargas[b] && (cargas[b].P > 0 || cargas[b].Q > 0)) leaves.push(b);
}

        for (const leafNode of leaves) {
const lineToRemove = mstLines.find(l => l.de === leafNode || l.para === leafNode);
            if (lineToRemove) {
const reducedLines = mstLines.filter(l => l !== lineToRemove);
                const cargaCortadaP = cargas[leafNode]?.P ||
0;
                const penalidadeCorte = (cargaCortadaP > 0) ? (cargaCortadaP * GA_PENALTIES.UNSERVED_MW) : 0;
if (penalidadeCorte >= bestFitness) {
continue;
}

                // *** MUDANÇA: Passa novos parâmetros ***
const reducedResult = await calculateSpecificFitness(reducedLines, nb, vMin, vMax, cargas, Sbase, Vbase_kV, maxNALinhas, substationBuses, isNormalOp);
let fitnessSimulado = reducedResult.fitness;
                 fitnessSimulado += penalidadeCorte;

                if (fitnessSimulado < bestFitness) {
                    bestFitness = fitnessSimulado;
bestData = {
                        ...reducedResult,
                        unservedLoadP: reducedResult.unservedLoadP + cargaCortadaP,
                        currentLinhas: reducedLines
};
}
            }
        }
    }
if (!isFinite(bestFitness)) bestFitness = 1e15;
    
    // *** MUDANÇA: Fallback DSU checa MÚLTIPLAS fontes ***
if(bestData.resBarras && bestData.resBarras.length > 0 && bestData.resBarras.some(b => b.isConnected)){
         // Usa os resultados do fluxo (igual a antes [cite: 535-536])
const finalConnected = new Set();
         bestData.resBarras.forEach(b => { if(b.isConnected) finalConnected.add(b.barra); });
         const finalUnservedSet = new Set();
         for(let b=1; b<=nb; b++) if(!finalConnected.has(b)) finalUnservedSet.add(b);
         bestData.unservedBuses = Array.from(finalUnservedSet);
} else {
         // Fallback usando DSU
const finalDSU = new DSU(nb);
if(Array.isArray(bestData.currentLinhas)) bestData.currentLinhas.forEach(l => finalDSU.union(l.de, l.para));
         
         // Cria um Set com as raízes de TODAS as fontes
         const sourceRoots = new Set(substationBuses.map(b => finalDSU.find(b)));
         
         const finalUnservedSet = new Set();
for(let b=1; b<=nb; b++) {
            // Se a raiz da barra 'b' NÃO ESTÁ no Set de raízes das fontes, ela está isolada.
            if (!sourceRoots.has(finalDSU.find(b))) {
                 finalUnservedSet.add(b);
            }
         }
         bestData.unservedBuses = Array.from(finalUnservedSet);
}

    return { fitness: bestFitness, data: bestData };
}
// *** FIM DA MUDANÇA ***

// --- MUDANÇA: Listener Principal (passa substationBuses) ---
self.onmessage = async (event) => {
    const { individual, index, staticData } = event.data;
console.log(`[Worker] Avaliando Indivíduo ${index}, Genes:`, individual);
    
    // *** MUDANÇA: Desempacota novo parâmetro ***
const { allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, substationBuses } = staticData;
    
try {
        // *** MUDANÇA: Passa novo parâmetro ***
const result = await calculateFitness(individual, allLines, linhaFalhaKeys, nb, vMin, vMax, maxNALinhas, cargas, Sbase, Vbase_kV, substationBuses);
        
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
// *** FIM DA MUDANÇA ***
