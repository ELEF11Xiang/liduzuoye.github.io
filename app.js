"use strict";

const DATA_FILES = {
  li: "./李杜/李白.csv",
  du: "./李杜/杜甫.csv",
  relations: "./李杜/李白-杜甫.csv",
};

const numberFormat = new Intl.NumberFormat("zh-CN");
const byId = (id) => document.getElementById(id);
const state = {
  poems: { li: new Map(), du: new Map() },
  records: [],
  pairs: [],
  pairByKey: new Map(),
  poemStats: { li: new Map(), du: new Map() },
  degreeFilter: null,
  level: "poem",
  focused: null,
  graph: { nodes: [], links: [], width: 860, height: 460, tx: 0, ty: 0, scale: 1 },
  invalidRows: 0,
  sourceMismatches: 0,
  loading: true,
};

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function decodeCSV(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(buffer);
    } catch (error) {
      throw new Error(`无法识别 CSV 文件编码：${error.message}`);
    }
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV 文件包含未闭合的引号。");
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

async function loadCSV(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取 ${url} 失败（HTTP ${response.status}）。`);
  return parseCSV(decodeCSV(await response.arrayBuffer()));
}

function parsePoems(rows, side) {
  const poems = new Map();
  for (const row of rows) {
    if (row.length < 4 || !row[0].trim() || !row[2].trim()) {
      state.invalidRows += 1;
      continue;
    }
    const [title, text, id, seq] = row;
    const key = id.trim();
    const order = Number(seq);
    if (!key || !Number.isFinite(order)) {
      state.invalidRows += 1;
      continue;
    }
    let poem = poems.get(key);
    if (!poem) {
      poem = { id: key, title: title.trim(), side, lines: [] };
      poems.set(key, poem);
    }
    if (poem.title !== title.trim()) {
      state.invalidRows += 1;
      continue;
    }
    poem.lines.push({ text, seq: order });
  }
  for (const poem of poems.values()) poem.lines.sort((a, b) => a.seq - b.seq);
  return poems;
}

function makePairKey(liId, duId) {
  return JSON.stringify([liId, duId]);
}

function normalizeRelations(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.length < 11) {
      state.invalidRows += 1;
      continue;
    }
    const [liAuthor, liTitle, liText, duAuthor, duTitle, duText, rawScore, liId, liSeq, duId, duSeq] = row;
    const li = state.poems.li.get(liId.trim());
    const du = state.poems.du.get(duId.trim());
    const score = Number(rawScore);
    const leftSeq = Number(liSeq);
    const rightSeq = Number(duSeq);
    if (liAuthor !== "李白" || duAuthor !== "杜甫" || !li || !du
      || !Number.isFinite(score) || !Number.isFinite(leftSeq) || !Number.isFinite(rightSeq)) {
      state.invalidRows += 1;
      continue;
    }
    const liSourceLine = li.lines.find((line) => line.seq === leftSeq);
    const duSourceLine = du.lines.find((line) => line.seq === rightSeq);
    if (li.title !== liTitle.trim() || liSourceLine?.text !== liText) state.sourceMismatches += 1;
    if (du.title !== duTitle.trim() || duSourceLine?.text !== duText) state.sourceMismatches += 1;
    const record = {
      liId: li.id, liTitle: liTitle.trim(), liText, liSeq: leftSeq,
      duId: du.id, duTitle: duTitle.trim(), duText, duSeq: rightSeq,
      rawScore: rawScore.trim(), score,
    };
    state.records.push(record);
    const key = makePairKey(li.id, du.id);
    let pair = groups.get(key);
    if (!pair) {
      pair = { key, liId: li.id, duId: du.id, li, du, records: [], scoreTotal: 0, scoreMin: Infinity, scoreMax: -Infinity };
      groups.set(key, pair);
    }
    pair.records.push(record);
    pair.scoreTotal += score;
    pair.scoreMin = Math.min(pair.scoreMin, score);
    pair.scoreMax = Math.max(pair.scoreMax, score);
  }
  state.pairs = [...groups.values()];
  state.pairByKey = new Map(state.pairs.map((pair) => [pair.key, pair]));
  for (const pair of state.pairs) {
    pair.count = pair.records.length;
    pair.scoreAverage = pair.scoreTotal / pair.count;
    pair.lineKeys = new Set(pair.records.map((record) => `${record.liId}\u0000${record.liSeq}\u0000${record.duId}\u0000${record.duSeq}`));
  }
  for (const side of ["li", "du"]) {
    const stats = new Map();
    for (const poem of state.poems[side].values()) stats.set(poem.id, { degree: 0, recordCount: 0 });
    for (const pair of state.pairs) {
      const poemId = side === "li" ? pair.liId : pair.duId;
      const stat = stats.get(poemId);
      if (stat) {
        stat.degree += 1;
        stat.recordCount += pair.count;
      }
    }
    state.poemStats[side] = stats;
  }
}

function formatNumber(value) {
  return numberFormat.format(value);
}

function animateStat(element, target) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) {
    element.textContent = formatNumber(target);
    return;
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    const start = performance.now();
    const duration = 900;
    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      element.textContent = formatNumber(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, { threshold: 0.4 });
  observer.observe(element);
}

function renderOverview() {
  const liPoems = state.poems.li.size;
  const duPoems = state.poems.du.size;
  const liLinked = [...state.poemStats.li.values()].filter((item) => item.degree > 0).length;
  const duLinked = [...state.poemStats.du.values()].filter((item) => item.degree > 0).length;
  animateStat(byId("statRows"), state.records.length);
  animateStat(byId("statPairs"), state.pairs.length);
  animateStat(byId("statLines"), new Set(state.records.map((record) =>
    `${record.liId}\u0000${record.liSeq}\u0000${record.duId}\u0000${record.duSeq}`)).size);
  byId("coverageLi").textContent = `${(liLinked / Math.max(liPoems, 1) * 100).toFixed(1)}%`;
  byId("coverageDu").textContent = `${(duLinked / Math.max(duPoems, 1) * 100).toFixed(1)}%`;
  byId("poemCountLi").textContent = `${formatNumber(liPoems)} 首作品`;
  byId("poemCountDu").textContent = `${formatNumber(duPoems)} 首作品`;
  const largest = Math.max(liPoems, duPoems, 1);
  byId("barLi").style.width = `${liPoems / largest * 100}%`;
  byId("barDu").style.width = `${duPoems / largest * 100}%`;
  byId("dataCaption").textContent = `数据来源：三份 CSV 原始语料。共读取 ${formatNumber(state.records.length)} 条有效关联记录；同名作品按诗歌 ID 区分。${state.invalidRows ? `另有 ${formatNumber(state.invalidRows)} 行无效或无法对应的记录未纳入统计。` : "所有关联记录均可对应到两位诗人的作品 ID。"}${state.sourceMismatches ? `关联记录中有 ${formatNumber(state.sourceMismatches)} 处题名或诗句字段与诗歌表不同；对照详情保留并标示关联表原文。` : ""} 关联分值沿用原始 G 列，不推断其语义或量纲。`;
  renderDegreeChart();

  const example = state.records[0];
  if (example) {
    byId("heroLiLine").textContent = example.liText;
    byId("heroLiTitle").textContent = `《${example.liTitle}》 · 语料关联诗句`;
    byId("heroDuLine").textContent = example.duText;
    byId("heroDuTitle").textContent = `《${example.duTitle}》 · 语料关联诗句`;
  }
}

function renderDegreeChart() {
  const root = byId("degreeChart");
  const width = Math.max(440, Math.round(root.clientWidth || 600));
  const height = 217;
  const pad = { top: 16, right: 13, bottom: 36, left: 36 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const labels = ["0", "1", "2", "3", "4+"];
  const bins = { li: labels.map(() => 0), du: labels.map(() => 0) };
  for (const side of ["li", "du"]) {
    for (const item of state.poemStats[side].values()) {
      const index = Math.min(item.degree, 4);
      bins[side][index] += 1;
    }
  }
  const maxCount = Math.max(1, ...bins.li, ...bins.du);
  const groups = labels.length;
  const groupWidth = plotWidth / groups;
  const barWidth = Math.min(18, groupWidth * 0.25);
  let svg = `<svg class="degree-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="按每首诗关联的对方作品数量统计的作品分布">`;
  for (let tick = 0; tick <= 2; tick += 1) {
    const y = pad.top + plotHeight * tick / 2;
    const value = Math.round(maxCount * (1 - tick / 2));
    svg += `<line class="chart-grid" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line><text class="chart-axis-label" x="${pad.left - 7}" y="${y + 3}" text-anchor="end">${value}</text>`;
  }
  labels.forEach((label, index) => {
    const center = pad.left + groupWidth * (index + 0.5);
    svg += `<text class="chart-axis-label" x="${center}" y="${height - 12}" text-anchor="middle">${label}</text>`;
    ["li", "du"].forEach((side, sideIndex) => {
      const value = bins[side][index];
      const barHeight = value / maxCount * plotHeight;
      const x = center + (sideIndex === 0 ? -barWidth - 1 : 1);
      const y = pad.top + plotHeight - barHeight;
      const selected = state.degreeFilter && state.degreeFilter.side === side && state.degreeFilter.bucket === index;
      const colorClass = side === "du" ? "chart-bar chart-bar-du" : "chart-bar";
      const title = `${side === "li" ? "李白" : "杜甫"}作品：${label}${index === 4 ? " 首及以上" : " 首"}关联对方作品；共 ${formatNumber(value)} 首。点击筛选网络。`;
      svg += `<rect class="${colorClass}${selected ? " selected" : ""}" x="${x}" y="${y}" width="${barWidth}" height="${Math.max(1, barHeight)}" rx="1" tabindex="0" role="button" aria-label="${escapeHTML(title)}" data-side="${side}" data-bucket="${index}"><title>${escapeHTML(title)}</title></rect>`;
    });
  });
  svg += "</svg>";
  root.innerHTML = svg;
  root.querySelectorAll(".chart-bar").forEach((bar) => {
    const activate = () => {
      const side = bar.dataset.side;
      const bucket = Number(bar.dataset.bucket);
      state.degreeFilter = state.degreeFilter?.side === side && state.degreeFilter.bucket === bucket
        ? null : { side, bucket };
      byId("poetFilter").value = side;
      byId("network").scrollIntoView({ behavior: "smooth" });
      renderDegreeChart();
      renderNetwork();
    };
    bar.addEventListener("click", activate);
    bar.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function getFilteredPairs() {
  const query = byId("networkSearch").value.trim().toLocaleLowerCase();
  const poet = byId("poetFilter").value;
  const minCount = Number(byId("minCount").value);
  let pairs = state.pairs.filter((pair) => {
    if (pair.count < minCount) return false;
    if (query) {
      const liMatches = pair.li.title.toLocaleLowerCase().includes(query);
      const duMatches = pair.du.title.toLocaleLowerCase().includes(query);
      if (poet === "li" && !liMatches) return false;
      if (poet === "du" && !duMatches) return false;
      if (poet === "both" && !liMatches && !duMatches) return false;
    }
    if (state.degreeFilter) {
      const { side, bucket } = state.degreeFilter;
      const check = (targetSide, poemId) => {
        if (targetSide !== side) return false;
        const degree = state.poemStats[side].get(poemId)?.degree ?? 0;
        return bucket === 4 ? degree >= 4 : degree === bucket;
      };
      if (!check("li", pair.liId) && !check("du", pair.duId)) return false;
    }
    return true;
  });
  const focusSide = byId("poetFilter").value;
  if (focusSide !== "both") {
    const focusTotals = new Map();
    for (const pair of pairs) {
      const poemId = focusSide === "li" ? pair.liId : pair.duId;
      focusTotals.set(poemId, (focusTotals.get(poemId) || 0) + pair.count);
    }
    const focusIds = new Set([...focusTotals]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .slice(0, 12)
      .map(([id]) => id));
    pairs = pairs.filter((pair) => focusIds.has(focusSide === "li" ? pair.liId : pair.duId));
  }
  pairs.sort((a, b) => {
    if (focusSide === "li") {
      const degreeDifference = (state.poemStats.li.get(b.liId)?.recordCount ?? 0) - (state.poemStats.li.get(a.liId)?.recordCount ?? 0);
      if (degreeDifference) return degreeDifference;
    } else if (focusSide === "du") {
      const degreeDifference = (state.poemStats.du.get(b.duId)?.recordCount ?? 0) - (state.poemStats.du.get(a.duId)?.recordCount ?? 0);
      if (degreeDifference) return degreeDifference;
    }
    return b.count - a.count || b.scoreAverage - a.scoreAverage || a.li.title.localeCompare(b.li.title, "zh-CN");
  });
  return pairs;
}

function nodeRadius(node) {
  if (state.level === "line") return 5;
  return Math.min(10, 4 + Math.log2((state.poemStats[node.side].get(node.poemId)?.degree ?? 0) + 1) * 1.65);
}

function graphPoint(event) {
  const point = byId("networkGraph").createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(byId("networkLayer").getScreenCTM().inverse());
}

function viewportPoint(event) {
  const point = byId("networkGraph").createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(byId("networkGraph").getScreenCTM().inverse());
}

function paintNetwork() {
  const svg = byId("networkGraph");
  const graph = state.graph;
  const layer = byId("networkLayer");
  if (!layer) return;
  layer.setAttribute("transform", `translate(${graph.tx} ${graph.ty}) scale(${graph.scale})`);
  let content = `<rect class="graph-background" x="0" y="0" width="${graph.width}" height="${graph.height}"></rect>
    <line class="graph-rule" x1="${graph.width / 2}" y1="46" x2="${graph.width / 2}" y2="${graph.height - 24}"></line>
    <text class="graph-side-title" x="44" y="29">LI BAI / 李白</text><text class="graph-side-title" x="${graph.width - 44}" y="29" text-anchor="end">DU FU / 杜甫</text>`;
  for (const link of graph.links) {
    const left = graph.nodesByKey.get(link.leftKey);
    const right = graph.nodesByKey.get(link.rightKey);
    if (!left || !right) continue;
    const leftRadius = nodeRadius(left);
    const rightRadius = nodeRadius(right);
    const midX = graph.width / 2;
    const width = Math.min(5, 1 + Math.log2(link.weight));
    content += `<path class="graph-link" d="M ${left.x + leftRadius} ${left.y} C ${midX - 73} ${left.y}, ${midX + 73} ${right.y}, ${right.x - rightRadius} ${right.y}" stroke-width="${width}" data-pair="${escapeHTML(link.pairKey)}" data-record="${link.recordIndex ?? ""}" tabindex="0" role="button" aria-label="${escapeHTML(`${left.title} 与 ${right.title}，${link.weight} 条诗句关联，点击对照`)}"><title>${escapeHTML(`${left.title} × ${right.title} · ${link.weight} 条诗句关联`)}${link.scoreLabel ? escapeHTML(` · 原始分值 ${link.scoreLabel}`) : ""}</title></path>`;
  }
  const hubY = graph.height / 2;
  for (const node of graph.nodes) {
    const isLi = node.side === "li";
    const hubX = isLi ? 43 : graph.width - 43;
    const poemEdge = isLi ? node.x - nodeRadius(node) : node.x + nodeRadius(node);
    const controlX = isLi ? 97 : graph.width - 97;
    content += `<path class="graph-hub-link ${isLi ? "node-li" : "node-du"}" d="M ${hubX} ${hubY} C ${controlX} ${hubY}, ${controlX} ${node.y}, ${poemEdge} ${node.y}"></path>`;
  }
  for (const node of graph.nodes) {
    const radius = nodeRadius(node);
    const focused = state.focused?.side === node.side && state.focused.id === node.poemId;
    const colorClass = node.side === "li" ? "node-li" : "node-du";
    const textX = node.side === "li" ? node.x + 15 : node.x - 15;
    const anchor = node.side === "li" ? "start" : "end";
    const subtitle = state.level === "line" && node.lineText ? `<text class="node-subtitle" x="${textX}" y="${node.y + 17}" text-anchor="${anchor}">${escapeHTML(node.lineText.length > 19 ? `${node.lineText.slice(0, 19)}…` : node.lineText)}</text>` : "";
    const hitX = node.side === "li" ? 0 : -180;
    content += `<g class="graph-node ${colorClass}${focused ? " is-focused" : ""}" data-key="${escapeHTML(node.key)}" data-side="${node.side}" data-id="${escapeHTML(node.poemId)}" transform="translate(${node.x} ${node.y})" tabindex="0" role="button" aria-label="${escapeHTML(`${node.title}，点击查看关联作品${node.lineText ? `：${node.lineText}` : ""}`)}"><rect class="node-hit-area" x="${hitX}" y="-13" width="180" height="34" fill="transparent"></rect><circle r="${radius}"></circle><text x="${node.side === "li" ? 15 : -15}" y="4" text-anchor="${anchor}">${escapeHTML(node.title.length > 15 ? `${node.title.slice(0, 15)}…` : node.title)}</text>${subtitle}</g>`;
  }
  content += `<g class="graph-hub node-li"><circle cx="43" cy="${hubY}" r="11"></circle><title>李白诗人节点</title></g><text class="graph-hub-label" x="43" y="${hubY + 25}" text-anchor="middle">李白</text>
    <g class="graph-hub node-du"><circle cx="${graph.width - 43}" cy="${hubY}" r="11"></circle><title>杜甫诗人节点</title></g><text class="graph-hub-label" x="${graph.width - 43}" y="${hubY + 25}" text-anchor="middle">杜甫</text>`;
  layer.innerHTML = content;
  svg.setAttribute("viewBox", `0 0 ${graph.width} ${graph.height}`);
}

function getLineLinks(pairs) {
  const links = [];
  for (const pair of pairs) {
    for (const record of pair.records) links.push({ pair, record, pairRecordIndex: pair.records.indexOf(record) });
  }
  links.sort((a, b) => b.record.score - a.record.score || a.pair.li.title.localeCompare(b.pair.li.title, "zh-CN"));
  return links.slice(0, 22);
}

function renderNetwork() {
  if (state.loading) return;
  const pairs = getFilteredPairs();
  const graph = state.graph;
  graph.nodes = [];
  graph.links = [];
  graph.nodesByKey = new Map();
  graph.width = 860;
  graph.tx = 0;
  graph.ty = 0;
  graph.scale = 1;
  let links;
  if (state.level === "poem") {
    links = pairs.slice(0, 22).map((pair) => ({
      pair,
      pairKey: pair.key,
      leftKey: `poem:li:${pair.liId}`,
      rightKey: `poem:du:${pair.duId}`,
      weight: pair.count,
    }));
    for (const link of links) {
      if (!graph.nodesByKey.has(link.leftKey)) {
        const node = { key: link.leftKey, side: "li", poemId: link.pair.liId, title: link.pair.li.title, x: 166 };
        graph.nodesByKey.set(link.leftKey, node);
        graph.nodes.push(node);
      }
      if (!graph.nodesByKey.has(link.rightKey)) {
        const node = { key: link.rightKey, side: "du", poemId: link.pair.duId, title: link.pair.du.title, x: 694 };
        graph.nodesByKey.set(link.rightKey, node);
        graph.nodes.push(node);
      }
      graph.links.push(link);
    }
  } else {
    links = getLineLinks(pairs).map(({ pair, record, pairRecordIndex }) => ({
      pair,
      pairKey: pair.key,
      record,
      recordIndex: pairRecordIndex,
      leftKey: `line:li:${record.liId}:${record.liSeq}`,
      rightKey: `line:du:${record.duId}:${record.duSeq}`,
      weight: pair.count,
      scoreLabel: record.rawScore,
    }));
    for (const link of links) {
      if (!graph.nodesByKey.has(link.leftKey)) {
        const node = { key: link.leftKey, side: "li", poemId: link.pair.liId, title: link.pair.li.title, lineText: link.record.liText, x: 166 };
        graph.nodesByKey.set(link.leftKey, node);
        graph.nodes.push(node);
      }
      if (!graph.nodesByKey.has(link.rightKey)) {
        const node = { key: link.rightKey, side: "du", poemId: link.pair.duId, title: link.pair.du.title, lineText: link.record.duText, x: 694 };
        graph.nodesByKey.set(link.rightKey, node);
        graph.nodes.push(node);
      }
      graph.links.push(link);
    }
  }
  const leftNodes = graph.nodes.filter((node) => node.side === "li").sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  const rightNodes = graph.nodes.filter((node) => node.side === "du").sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  const rows = Math.max(leftNodes.length, rightNodes.length, 1);
  graph.height = Math.max(460, rows * 39 + 98);
  for (const [index, node] of leftNodes.entries()) node.y = 68 + (index + 0.5) * (graph.height - 100) / leftNodes.length;
  for (const [index, node] of rightNodes.entries()) node.y = 68 + (index + 0.5) * (graph.height - 100) / rightNodes.length;
  const filterActive = byId("networkSearch").value.trim() || state.degreeFilter
    || byId("poetFilter").value !== "both" || Number(byId("minCount").value) > 1;
  const visibleCount = state.level === "poem" ? graph.links.length : graph.links.length;
  const maxShown = state.level === "poem" ? "22" : "22";
  const describedCount = state.level === "poem" ? `${formatNumber(pairs.length)} 组作品关系` : `${formatNumber(pairs.length)} 组作品关系`;
  byId("networkStatus").textContent = pairs.length
    ? `${describedCount} · 显示 ${visibleCount}${pairs.length > visibleCount || state.level === "line" ? ` / ${maxShown}` : ""} 条${state.level === "poem" ? "网络连接" : "诗句关联"}${filterActive ? " · 已筛选" : ""}`
    : "当前条件下没有关联作品；可降低筛选阈值或更换搜索词。";
  const svg = byId("networkGraph");
  svg.innerHTML = `<g id="networkLayer"></g>`;
  if (!graph.links.length) {
    graph.height = 460;
    svg.setAttribute("viewBox", `0 0 ${graph.width} ${graph.height}`);
    byId("networkLayer").innerHTML = `<text class="graph-empty" x="430" y="226" text-anchor="middle">此处暂无符合条件的关联。调整筛选条件，继续探索。</text>`;
  } else {
    paintNetwork();
  }
  renderHeatmap(pairs);
  if (state.focused) renderFocusPanel();
  bindGraphInteractions();
}

function renderFocusPanel() {
  const panel = byId("focusPanel");
  const focus = state.focused;
  if (!focus) {
    panel.innerHTML = '<p class="focus-placeholder">点击网络中的作品节点，查看它所关联的诗作。</p>';
    return;
  }
  const poem = state.poems[focus.side].get(focus.id);
  if (!poem) return;
  const related = state.pairs.filter((pair) => focus.side === "li" ? pair.liId === focus.id : pair.duId === focus.id)
    .sort((a, b) => b.count - a.count || b.scoreAverage - a.scoreAverage).slice(0, 3);
  const stat = state.poemStats[focus.side].get(focus.id);
  panel.innerHTML = `<span class="focus-poet ${focus.side}">${focus.side === "li" ? "LI BAI / 李白" : "DU FU / 杜甫"}</span>
    <h3 class="focus-title">${escapeHTML(poem.title)}</h3>
    <p class="focus-meta">作品 ID ${escapeHTML(poem.id)} · ${poem.lines.length} 行<br>关联 ${stat?.degree ?? 0} 首对方作品</p>
    ${related.map((pair) => `<button class="focus-related" data-pair="${escapeHTML(pair.key)}"><b>${escapeHTML(focus.side === "li" ? pair.du.title : pair.li.title)}</b><span>${pair.count} 条关联记录 · 点击查看对照</span></button>`).join("")}`;
  panel.querySelectorAll(".focus-related").forEach((button) => {
    button.addEventListener("click", () => openPairDialog(state.pairByKey.get(button.dataset.pair)));
  });
}

function renderHeatmap(pairs) {
  const root = byId("heatmapContainer");
  if (!pairs.length) {
    root.innerHTML = '<p class="matrix-empty">当前筛选下没有可显示的作品关联。</p>';
    return;
  }
  const liTotals = new Map();
  const duTotals = new Map();
  for (const pair of pairs) {
    liTotals.set(pair.liId, (liTotals.get(pair.liId) || 0) + pair.count);
    duTotals.set(pair.duId, (duTotals.get(pair.duId) || 0) + pair.count);
  }
  const topPoems = (totals, side) => [...totals]
    .sort((a, b) => b[1] - a[1] || state.poems[side].get(a[0]).title.localeCompare(state.poems[side].get(b[0]).title, "zh-CN"))
    .slice(0, 10)
    .map(([id]) => state.poems[side].get(id));
  const liWorks = topPoems(liTotals, "li");
  const duWorks = topPoems(duTotals, "du");
  const currentPairs = new Map(pairs.map((pair) => [pair.key, pair]));
  const maxCount = Math.max(1, ...pairs.map((pair) => pair.count));
  let html = '<table class="heatmap-table"><thead><tr><th scope="col">李白作品 ↓<br>杜甫作品 →</th>';
  for (const poem of duWorks) html += `<th scope="col" title="${escapeHTML(poem.title)}">${escapeHTML(poem.title.length > 8 ? `${poem.title.slice(0, 8)}…` : poem.title)}</th>`;
  html += "</tr></thead><tbody>";
  for (const liPoem of liWorks) {
    html += `<tr><th scope="row" title="${escapeHTML(liPoem.title)}">${escapeHTML(liPoem.title)}</th>`;
    for (const duPoem of duWorks) {
      const pair = currentPairs.get(makePairKey(liPoem.id, duPoem.id));
      if (!pair) {
        html += '<td><button class="heat-cell" disabled aria-label="无关联">·</button></td>';
        continue;
      }
      const intensity = 0.12 + (pair.count / maxCount) * 0.68;
      const foreground = intensity > 0.52 ? "color:var(--paper)" : "color:var(--ink)";
      const label = `${liPoem.title} × ${duPoem.title}：${pair.count} 条诗句关联记录，点击查看对照`;
      html += `<td><button class="heat-cell has-value" style="background:rgba(166,75,54,${intensity.toFixed(2)});${foreground}" data-pair="${escapeHTML(pair.key)}" title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}">${pair.count}</button></td>`;
    }
    html += "</tr>";
  }
  root.innerHTML = `${html}</tbody></table>`;
  root.querySelectorAll(".heat-cell.has-value").forEach((button) => {
    button.addEventListener("click", () => openPairDialog(state.pairByKey.get(button.dataset.pair)));
  });
}

function bindGraphInteractions() {
  const svg = byId("networkGraph");
  svg.onpointerdown = (event) => {
    const nodeElement = event.target.closest?.(".graph-node");
    const linkElement = event.target.closest?.(".graph-link");
    const targetNode = nodeElement ? state.graph.nodesByKey.get(nodeElement.dataset.key) : null;
    if (event.button !== 0) return;
    if (linkElement) return;
    svg.setPointerCapture(event.pointerId);
    if (targetNode) {
      const point = graphPoint(event);
      svg._gesture = { type: "node", node: targetNode, startX: point.x, startY: point.y, moved: false };
    } else {
      const viewport = viewportPoint(event);
      svg._gesture = { type: "pan", x: viewport.x, y: viewport.y, tx: state.graph.tx, ty: state.graph.ty, moved: false };
    }
    svg.classList.add("is-dragging");
  };
  svg.onpointermove = (event) => {
    const gesture = svg._gesture;
    if (!gesture) return;
    if (gesture.type === "node") {
      const point = graphPoint(event);
      if (Math.abs(point.y - gesture.startY) > 2 || Math.abs(point.x - gesture.startX) > 2) gesture.moved = true;
      gesture.node.y = Math.max(52, Math.min(state.graph.height - 26, point.y));
      paintNetwork();
    } else if (gesture.type === "pan") {
      const point = viewportPoint(event);
      const dx = point.x - gesture.x;
      const dy = point.y - gesture.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) gesture.moved = true;
      state.graph.tx = gesture.tx + dx;
      state.graph.ty = gesture.ty + dy;
      paintNetwork();
    }
  };
  svg.onpointerup = (event) => {
    const gesture = svg._gesture;
    if (!gesture) return;
    svg._gesture = null;
    svg.classList.remove("is-dragging");
    if (gesture.type === "node") {
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".graph-node");
      if (!gesture.moved && element) {
        const graphNode = state.graph.nodesByKey.get(element.dataset.key);
        if (graphNode) state.focused = { side: graphNode.side, id: graphNode.poemId };
        renderFocusPanel();
        paintNetwork();
      }
    }
  };
  svg.onpointercancel = () => { svg._gesture = null; svg.classList.remove("is-dragging"); };
  svg.onclick = (event) => {
    const linkElement = event.target.closest?.(".graph-link");
    if (!linkElement) return;
    const pair = state.pairByKey.get(linkElement.dataset.pair);
    if (pair) openPairDialog(pair, linkElement.dataset.record === "" ? null : Number(linkElement.dataset.record));
  };
  svg.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const linkElement = event.target.closest?.(".graph-link");
    if (linkElement) {
      event.preventDefault();
      const pair = state.pairByKey.get(linkElement.dataset.pair);
      if (pair) openPairDialog(pair, linkElement.dataset.record === "" ? null : Number(linkElement.dataset.record));
      return;
    }
    const nodeElement = event.target.closest?.(".graph-node");
    if (nodeElement) {
      event.preventDefault();
      const node = state.graph.nodesByKey.get(nodeElement.dataset.key);
      if (node) {
        state.focused = { side: node.side, id: node.poemId };
        renderFocusPanel();
        paintNetwork();
      }
    }
  };
  svg.onwheel = (event) => {
    event.preventDefault();
    const point = viewportPoint(event);
    const oldScale = state.graph.scale;
    const newScale = Math.max(.65, Math.min(2.4, oldScale * (event.deltaY < 0 ? 1.12 : .89)));
    state.graph.tx = point.x - (point.x - state.graph.tx) * newScale / oldScale;
    state.graph.ty = point.y - (point.y - state.graph.ty) * newScale / oldScale;
    state.graph.scale = newScale;
    paintNetwork();
  };
}

function renderPoemLines(poem, markedSeqs, relationBySeq) {
  const marked = new Set(markedSeqs);
  return poem.lines.map((line) => {
    const match = marked.has(line.seq);
    const linkedTexts = [...(relationBySeq.get(line.seq) || new Set())].filter((text) => text !== line.text);
    const linkedMarkup = linkedTexts.length
      ? `<small>关联表原文：${linkedTexts.map((text) => `「${escapeHTML(text)}」`).join(" / ")}</small>`
      : "";
    return `<li class="${match ? "is-match" : ""}"><span class="line-seq">${escapeHTML(line.seq)}</span><span>${escapeHTML(line.text)}${match ? linkedMarkup : ""}</span></li>`;
  }).join("");
}

function openPairDialog(pair, recordIndex = null) {
  if (!pair) return;
  const records = recordIndex === null ? pair.records : [pair.records[recordIndex]].filter(Boolean);
  if (!records.length) return;
  const liSeqs = [...new Set(records.map((record) => record.liSeq))];
  const duSeqs = [...new Set(records.map((record) => record.duSeq))];
  const liRelated = new Map();
  const duRelated = new Map();
  for (const record of records) {
    if (!liRelated.has(record.liSeq)) liRelated.set(record.liSeq, new Set());
    if (!duRelated.has(record.duSeq)) duRelated.set(record.duSeq, new Set());
    liRelated.get(record.liSeq).add(record.liText);
    duRelated.get(record.duSeq).add(record.duText);
  }
  const liSourceTitles = [...new Set(records.map((record) => record.liTitle))].filter((title) => title !== pair.li.title);
  const duSourceTitles = [...new Set(records.map((record) => record.duTitle))].filter((title) => title !== pair.du.title);
  const scoreValues = records.map((record) => record.rawScore);
  const scoreRange = scoreValues.length === 1 ? scoreValues[0] : `${Math.min(...records.map((record) => record.score))}–${Math.max(...records.map((record) => record.score))}`;
  const isOneRecord = recordIndex !== null;
  byId("dialogContent").innerHTML = `<div class="dialog-body">
    <p class="dialog-eyebrow">${isOneRecord ? "A POETIC ECHO / 单条诗句关联" : "A POETIC PAIR / 作品关联"} · 原始语料对照</p>
    <h2 class="dialog-title">《${escapeHTML(pair.li.title)}》<span style="color:var(--gold)"> × </span>《${escapeHTML(pair.du.title)}》</h2>
    <div class="dialog-poems">
      <article class="dialog-poem"><h3 class="dialog-author li">李白 · 《${escapeHTML(pair.li.title)}》</h3><p class="focus-meta">作品 ID ${escapeHTML(pair.li.id)}${liSourceTitles.length ? `<br>关联表题名：${liSourceTitles.map(escapeHTML).join(" / ")}` : ""}</p><ul>${renderPoemLines(pair.li, liSeqs, liRelated)}</ul></article>
      <article class="dialog-poem"><h3 class="dialog-author du">杜甫 · 《${escapeHTML(pair.du.title)}》</h3><p class="focus-meta">作品 ID ${escapeHTML(pair.du.id)}${duSourceTitles.length ? `<br>关联表题名：${duSourceTitles.map(escapeHTML).join(" / ")}` : ""}</p><ul>${renderPoemLines(pair.du, duSeqs, duRelated)}</ul></article>
    </div>
    <div class="dialog-metrics">
      <div class="dialog-metric"><span>${isOneRecord ? "本次查看的记录" : "作品对关联记录数"}</span><b>${isOneRecord ? "1" : formatNumber(pair.count)}</b></div>
      <div class="dialog-metric"><span>诗句序号组合数</span><b>${formatNumber(isOneRecord ? 1 : pair.lineKeys.size)}</b></div>
      <div class="dialog-metric"><span>G 列原始分值${isOneRecord ? "" : "范围"}</span><b>${escapeHTML(scoreRange)}</b></div>
    </div>
    <p class="chart-footnote">高亮行标记 CSV 中实际对应的诗句。括号中的数字为源 CSV 诗句序号；原始分值沿用 G 列，不对其相似度语义或量纲作推断。</p>
  </div>`;
  const dialog = byId("detailDialog");
  if (!dialog.open) dialog.showModal();
}

function renderEchoResults(limit = 8) {
  const query = byId("echoSearch").value.trim().toLocaleLowerCase();
  const list = state.pairs.filter((pair) => !query
    ? true
    : pair.li.title.toLocaleLowerCase().includes(query) || pair.du.title.toLocaleLowerCase().includes(query));
  list.sort((a, b) => b.count - a.count || b.scoreAverage - a.scoreAverage || a.li.title.localeCompare(b.li.title, "zh-CN"));
  const visible = list.slice(0, limit);
  byId("echoResultCount").textContent = query
    ? `找到 ${formatNumber(list.length)} 组作品关联`
    : `语料精选 · ${formatNumber(state.pairs.length)} 组作品关联`;
  byId("echoEmpty").hidden = visible.length > 0;
  byId("echoResults").innerHTML = visible.map((pair) => {
    const representative = [...pair.records].sort((a, b) => b.score - a.score)[0];
    return `<button class="echo-card" data-pair="${escapeHTML(pair.key)}" aria-label="查看《${escapeHTML(pair.li.title)}》与《${escapeHTML(pair.du.title)}》的诗句关联">
      <span class="echo-side"><span class="echo-poem-name">李白 · 《${escapeHTML(pair.li.title)}》</span><p>${escapeHTML(representative.liText)}</p></span>
      <span class="echo-connection"><span>↔</span><small>${pair.count} 条</small></span>
      <span class="echo-side"><span class="echo-poem-name">杜甫 · 《${escapeHTML(pair.du.title)}》</span><p>${escapeHTML(representative.duText)}</p></span>
    </button>`;
  }).join("") + (list.length > visible.length
    ? `<button id="showMore" class="quiet-button" style="grid-column:1/-1;justify-self:center;padding:17px">继续查看关联作品 ↓</button>`
    : "");
  byId("echoResults").querySelectorAll(".echo-card").forEach((card) => {
    card.addEventListener("click", () => openPairDialog(state.pairByKey.get(card.dataset.pair)));
  });
  const moreButton = byId("showMore");
  if (moreButton) moreButton.addEventListener("click", () => renderEchoResults(limit + 16));
}

function randomExplore() {
  if (!state.records.length) return;
  const record = state.records[Math.floor(Math.random() * state.records.length)];
  const pair = state.pairByKey.get(makePairKey(record.liId, record.duId));
  const index = pair.records.indexOf(record);
  openPairDialog(pair, index);
}

function bindControls() {
  byId("networkSearch").addEventListener("input", () => {
    state.degreeFilter = null;
    renderDegreeChart();
    renderNetwork();
  });
  byId("poetFilter").addEventListener("change", () => {
    if (state.degreeFilter && state.degreeFilter.side !== byId("poetFilter").value) state.degreeFilter = null;
    renderDegreeChart();
    renderNetwork();
  });
  byId("minCount").addEventListener("input", () => {
    byId("minCountLabel").textContent = byId("minCount").value;
    renderNetwork();
  });
  document.querySelectorAll(".segmented button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".segmented button").forEach((item) => item.classList.toggle("active", item === button));
      state.level = button.dataset.level;
      renderNetwork();
    });
  });
  byId("resetView").addEventListener("click", () => {
    state.focused = null;
    state.degreeFilter = null;
    state.level = "poem";
    document.querySelectorAll(".segmented button").forEach((item) => item.classList.toggle("active", item.dataset.level === "poem"));
    byId("networkSearch").value = "";
    byId("poetFilter").value = "both";
    byId("minCount").value = "1";
    byId("minCountLabel").textContent = "1";
    renderDegreeChart();
    renderFocusPanel();
    renderNetwork();
  });
  byId("echoSearch").addEventListener("input", () => renderEchoResults());
  byId("randomExplore").addEventListener("click", randomExplore);
  byId("dialogClose").addEventListener("click", () => byId("detailDialog").close());
  byId("detailDialog").addEventListener("click", (event) => {
    if (event.target === byId("detailDialog")) byId("detailDialog").close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && byId("detailDialog").open) byId("detailDialog").close();
  });
  const toggle = byId("menuToggle");
  toggle.addEventListener("click", () => {
    const open = byId("mainNav").classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  byId("mainNav").querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    byId("mainNav").classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
  }));
  if ("IntersectionObserver" in window) {
    const navObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      document.querySelectorAll(".main-nav a").forEach((link) => link.classList.toggle("active", link.hash === `#${visible.target.id}`));
    }, { rootMargin: "-20% 0px -65% 0px", threshold: [0, .1, .4] });
    document.querySelectorAll("main > section[id]").forEach((section) => navObserver.observe(section));
  }
}

async function initialize() {
  bindControls();
  try {
    const [liRows, duRows, relationRows] = await Promise.all([
      loadCSV(DATA_FILES.li),
      loadCSV(DATA_FILES.du),
      loadCSV(DATA_FILES.relations),
    ]);
    state.poems.li = parsePoems(liRows, "li");
    state.poems.du = parsePoems(duRows, "du");
    normalizeRelations(relationRows);
    state.loading = false;
    renderOverview();
    renderNetwork();
    renderEchoResults();
  } catch (error) {
    console.error("诗歌语料加载失败：", error);
    const alert = byId("loadError");
    alert.hidden = false;
    alert.textContent = `诗歌数据读取失败：${error.message} 请在项目目录运行 start.bat（或使用 python -m http.server 8000），然后通过 http://localhost:8000 打开页面；不要直接双击 index.html。`;
    byId("networkStatus").textContent = "数据加载失败，网络尚未生成。";
    byId("echoResultCount").textContent = "诗歌索引尚未加载";
    state.loading = false;
  }
}

initialize();
