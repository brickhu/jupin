/* 句拼 admin 前端 —— 浏览器直接跑 ES module，**没有构建步骤**。
   ⚠️ 为什么不做打包：这个台子和 tools/admin/server.ts 一起改、一起跑，
      中间夹一层构建只会让「我明明改了」变成日常。

   路由（history API，服务端对没有扩展名的路径回退到 index.html）：
     /articles       句库列表（/ 也归到这里）
     /article/<id>   句子详情（点「详情」进，详情页里「编辑」弹抽屉）
     /energy         能量（占位）
     /account        管理员账号
   环境不在这里切：它在**登录页**选定，header 只显示一个标识。 */

const $ = (sel, root) => (root || document).querySelector(sel)
/**
 * ⭐ 档位 → 中文标签。**前端不硬编码这份映射** —— 服务端随列表下发 levelLabels
 *    （唯一来源是 shared/level.ts 的 LEVEL_LABEL，见 /api/articles）。
 *    （这里原来硬编码了一份 DIFF，与 shared 各写一遍 —— 同一事实两个来源。）
 */
function levelLabel(v) {
  if (v === null || v === undefined) return "未定"
  return (state.levelLabels && state.levelLabels[String(v)]) || "未定"
}

/** 判据分的中文名 —— 顺序与 shared 的 DifficultyScores 一致：[词汇, 发音, 长度] */
const SCORE_NAMES = ["词汇", "发音", "长度"]

/**
 * ⭐ 三个判据分 → 档位 + 加权分。
 *
 * ⚠️⚠️ **权重与切分点由服务端随 bootstrap 下发**（唯一来源是 shared/level.ts）——
 *    前端绝不自己写一份：那样「改分数实时看档位」显示的结果，
 *    和入库时服务端算出来的档位就会不一致，而页面看起来完全正常。
 * @returns {{difficulty:number, score:number}|null} 分不全 / 公式没下发 ⇒ null
 */
function diffFromScores(scores) {
  if (!Array.isArray(scores) || scores.length !== 3) return null
  const w = state.difficultyWeights
  const bands = state.difficultyBands
  if (!Array.isArray(w) || w.length < 3 || !Array.isArray(bands) || bands.length < 3) return null
  let total = 0
  let sum = 0
  for (let i = 0; i < 3; i++) {
    const n = Number(scores[i])
    if (!Number.isFinite(n) || n < 1 || n > 5) return null
    total += n * w[i]
    sum += w[i]
  }
  if (!sum) return null
  const score = Math.round((total / sum) * 10) / 10
  let lv = 0
  bands.forEach(function (b) { if (score >= b) lv += 1 })
  return { difficulty: lv, score: score }
}

/** 判据分 → "词汇 4 · 发音 2 · 长度 3 = 3.1 高级"；分不全就是空串 */
function scoresText(scores) {
  const r = diffFromScores(scores)
  if (!r) return ""
  const parts = scores.map(function (v, i) { return SCORE_NAMES[i] + " " + v })
  return parts.join(" · ") + " = " + r.score.toFixed(1) + " " + levelLabel(r.difficulty)
}

const ENV_LABEL = { local: "本机", dev: "dev", prod: "prod" }

const state = {
  authed: false,
  user: null,
  env: "local",
  envs: [],
  pickedEnv: "local",
  list: [],
  detail: null,
  detailWords: [],
  edit: null,
  editWords: [],
  /** 详情页里「改了但还没提交」的字段（也会写进 localStorage 草稿） */
  pending: {},
  editorMode: "create",
  playingId: null,
  busy: false,
}

/* ============================ 基础 ============================ */

async function api(path, opt) {
  const options = opt || {}
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch (e) { /* 可能是纯文本的 403/404 */ }
  if (!res.ok || !json || json.ok !== true) {
    if (res.status === 401 && state.authed) { state.authed = false; renderAuth() }
    const err = new Error((json && json.error) || "HTTP " + res.status)
    err.status = res.status
    throw err
  }
  return json.data
}

function toast(msg, bad) {
  const node = $("#toast")
  node.textContent = msg
  node.className = bad ? "toast bad" : "toast"
  node.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(function () { node.hidden = true }, 3200)
}

const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms) })

function errBox(sel, msg) {
  const node = $(sel)
  node.textContent = msg || ""
  node.hidden = !msg
}

/** 库里的时间是 UTC 的 Date，显示成本地时间 —— 运营看的是「我什么时候发的」 */
function fmtTime(iso) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  const p = function (n) { return String(n).padStart(2, "0") }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes())
}

/* ============================ 登录（含环境选择） ============================ */

function renderAuth() {
  $("#login-view").hidden = state.authed
  $("#shell").hidden = !state.authed
  if (state.authed) {
    renderEnvBadge()
    $("#acc-user").textContent = state.user || "—"
    $("#acc-env").textContent = (ENV_LABEL[state.env] || state.env)
  } else {
    setTimeout(function () { $('#login-form [name="password"]').focus() }, 0)
  }
}

function renderEnvBadge() {
  const node = $("#env-badge")
  node.textContent = ENV_LABEL[state.env] || state.env
  node.className = "env-badge" + (state.env === "local" ? "" : " " + state.env)
  node.title = "这次会话写的是「" + (ENV_LABEL[state.env] || state.env) + "」的库（换环境要退出后重新登录）"
}

/**
 * 登录页的环境选择。
 * ⚠️ 不可用的环境**列出来但禁掉**、并把原因写在旁边 —— 直接隐藏的话，
 *    「dev 怎么没了」会变成一个需要翻代码才能回答的问题。
 */
async function loadLoginEnvs() {
  const box = $("#login-envs")
  /**
   * ⚠️ 环境列表要真探一次云库（约 5 秒），所以先给一句话。
   *    这段空窗期里提交也不会错：state.pickedEnv 的初值是 local ——
   *    那是**最安全**的默认（不会把内容写进云环境）。
   */
  box.textContent = "正在探测各环境…"
  try {
    const data = await api("/api/envs")
    state.envs = data.list
    let pick = data.current
    const cur = data.list.find(function (e) { return e.mode === pick })
    if (!cur || !cur.reachable) {
      const first = data.list.find(function (e) { return e.reachable })
      pick = first ? first.mode : ""
    }
    state.pickedEnv = pick
    box.textContent = ""
    data.list.forEach(function (e) {
      const lab = document.createElement("label")
      lab.className = "env-option" + (e.reachable ? "" : " dead") + (e.mode === pick ? " on" : "")
      const radio = document.createElement("input")
      radio.type = "radio"
      radio.name = "env"
      radio.value = e.mode
      radio.checked = e.mode === pick
      radio.disabled = !e.reachable
      radio.addEventListener("change", function () {
        state.pickedEnv = e.mode
        box.querySelectorAll(".env-option").forEach(function (x) { x.classList.remove("on") })
        lab.classList.add("on")
        $("#login-env-note").textContent = ""
      })
      const name = document.createElement("span")
      name.className = "env-name"
      name.textContent = e.label
      lab.appendChild(radio)
      lab.appendChild(name)
      if (!e.reachable) {
        const note = document.createElement("span")
        note.className = "env-note"
        note.textContent = "不可用：" + (e.note || "未知原因")
        lab.appendChild(note)
      }
      box.appendChild(lab)
    })
    const dead = data.list.filter(function (e) { return !e.reachable })
    $("#login-env-note").textContent = dead.length
      ? dead.length + " 个环境当前不可用（原因见上面）。不可用通常是没部署 / 库没建 —— 跑一次 deploy-cloud.mjs 即可。"
      : ""
  } catch (e) {
    box.textContent = "读不到环境列表：" + e.message
    $("#login-env-note").textContent = ""
  }
}

$("#login-form").addEventListener("submit", async function (ev) {
  ev.preventDefault()
  errBox("#login-error", "")
  const user = ev.target.user.value.trim()
  const password = ev.target.password.value
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: { user: user, password: password, env: state.pickedEnv },
    })
    state.authed = true
    state.user = data.user
    state.env = data.env
    renderAuth()
    await afterLogin()
  } catch (e) {
    errBox("#login-error", e.message)
  }
})

$("#logout").addEventListener("click", async function () {
  await api("/api/logout", { method: "POST" }).catch(function () {})
  state.authed = false
  closeEditor()
  history.replaceState({}, "", "/articles")
  renderAuth()
  await loadLoginEnvs()
})

async function afterLogin() {
  await loadEnvs().catch(function (e) { toast("环境列表读不到：" + e.message, true) })
  render()
}

/** 已登录后的环境列表：只用来在「管理员账号」页展示状态，**不提供切换** */
async function loadEnvs() {
  const data = await api("/api/envs")
  state.envs = data.list
  renderEnvStatus()
}

function renderEnvStatus() {
  const box = $("#acc-envs")
  box.textContent = ""
  state.envs.forEach(function (item) {
    const line = document.createElement("div")
    line.className = "env-line" + (item.reachable ? "" : " bad")
    line.textContent = (item.mode === state.env ? "● " : "○ ") + item.label +
      (item.reachable ? "（可用）" : "：" + (item.note || "不可用"))
    box.appendChild(line)
  })
}

/* ============================ 路由 ============================ */

function parseRoute(path) {
  if (path.indexOf("/article/") === 0) {
    const id = path.slice("/article/".length)
    return id ? { view: "detail", id: id } : { view: "library" }
  }
  if (path === "/energy") return { view: "energy" }
  if (path === "/account") return { view: "account" }
  return { view: "library" }
}

function navigate(path) {
  if (path !== location.pathname) history.pushState({}, "", path)
  render()
}

function showView(name) {
  ["library", "detail", "energy", "account"].forEach(function (v) {
    const node = document.getElementById("view-" + v)
    if (node) node.hidden = v !== name
  })
  // 详情页也属于「句库」，导航高亮要跟着
  const active = name === "detail" ? "library" : name
  document.querySelectorAll(".menu .nav[data-view]").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-view") === active)
  })
}

function render() {
  if (!state.authed) return
  const route = parseRoute(location.pathname)
  showView(route.view)
  if (route.view === "library") loadList()
  else if (route.view === "detail") loadDetail(route.id)
  else if (route.view === "account") renderAccount()
}

document.querySelectorAll(".nav[data-view]").forEach(function (b) {
  b.addEventListener("click", function () {
    const v = b.getAttribute("data-view")
    navigate(v === "library" ? "/articles" : "/" + v)
  })
})

window.addEventListener("popstate", render)

$("#back-link").addEventListener("click", function (ev) {
  ev.preventDefault()
  navigate("/articles")
})

/* ============================ 句库列表 ============================ */

let qTimer = 0
$("#q").addEventListener("input", function () {
  clearTimeout(qTimer)
  qTimer = setTimeout(loadList, 250)
})

async function loadList() {
  errBox("#list-error", "")
  try {
    const data = await api("/api/articles?q=" + encodeURIComponent($("#q").value.trim()))
    state.list = data.list
    applyServerConsts(data)
    renderList()
  } catch (e) {
    errBox("#list-error", e.message)
    state.list = []
    renderList()
  }
}

function renderList() {
  const tbody = $("#rows")
  tbody.textContent = ""
  $("#count").textContent = state.list.length + " 条"
  $("#empty").hidden = state.list.length > 0
  state.list.forEach(function (row) {
    const tr = document.createElement("tr")

    // 试听：列表里唯一「一行只做一件事」的控件
    const playTd = document.createElement("td")
    playTd.className = "c-play"
    const play = document.createElement("button")
    play.type = "button"
    play.className = "play"
    play.dataset.id = row.id
    play.textContent = "▶"
    play.title = "试听标准音"
    play.addEventListener("click", function () { toggleRowPlay(row.id) })
    playTd.appendChild(play)
    tr.appendChild(playTd)

    tr.appendChild(cell(row.text || row.id.slice(0, 12) + "…", "en"))
    tr.appendChild(cell(row.translation || "—", "zh"))
    // ⭐ 一个档位 + 它的加权分（三个判据分只在详情 / 候选里展开）
    tr.appendChild(cell(
      levelLabel(row.difficulty) + (row.score === null || row.score === undefined ? "" : " " + row.score.toFixed(1)),
      "c-diff nowrap",
    ))
    tr.appendChild(cell(fmtTime(row.publishedAt), "c-time nowrap"))

    const stTd = document.createElement("td")
    stTd.className = "c-state nowrap"
    const badge = document.createElement("span")
    const live = row.isActive === true || row.isActive === 1
    badge.className = "badge " + (live ? "live" : "draft")
    badge.textContent = live ? "已发布" : "草稿"
    stTd.appendChild(badge)
    tr.appendChild(stTd)

    const actTd = document.createElement("td")
    actTd.className = "c-act act"
    const detailBtn = document.createElement("button")
    detailBtn.type = "button"
    detailBtn.className = "ghost"
    detailBtn.textContent = "详情"
    detailBtn.addEventListener("click", function () { navigate("/article/" + row.id) })
    actTd.appendChild(detailBtn)
    tr.appendChild(actTd)

    tbody.appendChild(tr)
  })
  renderPlayState()
}

function cell(text, cls) {
  const td = document.createElement("td")
  if (cls) td.className = cls
  td.textContent = text
  return td
}

/* ---- 列表试听（一个共用 audio，避免同时放好几条） ---- */

function toggleRowPlay(id) {
  const a = $("#row-audio")
  if (state.playingId === id) { stopRowPlay(); return }
  stopRowPlay()
  a.src = "/api/audio/" + id + ".mp3?t=" + Date.now()
  const p = a.play()
  if (p && p.catch) {
    p.catch(function () { toast("这条还没有标准音，或音频读不到", true); stopRowPlay() })
  }
  state.playingId = id
  renderPlayState()
}

function stopRowPlay() {
  const a = $("#row-audio")
  a.pause()
  state.playingId = null
  renderPlayState()
}

function renderPlayState() {
  document.querySelectorAll("#rows button.play").forEach(function (b) {
    const on = b.dataset.id === state.playingId
    b.classList.toggle("on", on)
    b.textContent = on ? "⏸" : "▶"
    b.title = on ? "停止" : "试听标准音"
  })
}

$("#row-audio").addEventListener("ended", stopRowPlay)

/* ============================ 句子详情页 ============================ */

/* ---- 本地草稿：改了但**没提交**的东西必须活过刷新 ---- */

/**
 * ⭐ 为什么用 localStorage，而不是「留在内存里就行」：
 *    详情页现在是「改几处 → 点更新」的节奏，中间只要刷新一次，
 *    没提交的改动就没了 —— 而人一旦被这样坑过，就再也不敢先改后提交。
 *
 * ⚠️ 按 **env + id** 存：同一个 id 在 local 和 dev 是两条不同的记录
 *    （内容文件同一份，但库不同、发布时间不同），混着用会串味。
 * ⚠️ localStorage 可能被禁用/写满 —— 所有访问都包 try/catch：
 *    存不下顶多丢草稿，**不能**让整个页面崩掉。
 */
const DRAFT_KEY = "jushuo_admin_detail_draft_v1"

function draftKeyOf(id) {
  return state.env + ":" + id
}

function readDraft(id) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}")
    const one = all[draftKeyOf(id)]
    return one && typeof one === "object" ? one : null
  } catch (e) {
    return null
  }
}

function writeDraft(id, patch) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}")
    const k = draftKeyOf(id)
    if (patch === null) delete all[k]
    else all[k] = Object.assign({}, all[k], patch)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all))
  } catch (e) {
    /* 存不下就算了，不影响主流程 */
  }
}

function clearDraft(id) {
  writeDraft(id, null)
}

/**
 * ⭐ 把服务端随响应下发的**常量**收进 state：档位标签映射 + 难度公式（权重 / 切分点）。
 *
 * ⚠️⚠️ 列表与详情**都要调**：只让列表接口下发时，直接打开 / 刷新一个详情页
 *    （链接分享、书签、F5）会因为 state 里没有这些常量而把档位显示成「未定」——
 *    页面上看起来完全正常，只是难度那一栏一直空着（用户 2026-09 实测撞到）。
 * ⚠️ 前端不自己抄一份映射与阈值：调了 shared/level.ts 就该跟着变，否则页面开始说谎。
 */
function applyServerConsts(data) {
  if (data.levelLabels) state.levelLabels = data.levelLabels
  if (data.difficultyWeights) state.difficultyWeights = data.difficultyWeights
  if (data.difficultyBands) state.difficultyBands = data.difficultyBands
  renderScoreHint()
}

/**
 * ⭐ 「总分」那个 ? 的说明**从服务端下发的权重算出来**，不在 HTML 里写死。
 *
 * ⚠️ 为什么要这么绕：权重是 shared/level.ts 的常量（现在是 5 / 3 / 2）——
 *    HTML 里写死一句「(词汇×5 + 发音×3 + 长度×2) / 10」的话，
 *    哪天调了权重，这个提示就开始**说谎**，而页面上看起来完全正常。
 */
function renderScoreHint() {
  const el = $("#dt-score-hint")
  if (!el) return
  const w = state.difficultyWeights
  const bands = state.difficultyBands
  if (!Array.isArray(w) || w.length < 3 || !Array.isArray(bands) || bands.length < 3) {
    el.title = "三个判据分加权合成的总分"
    return
  }
  const sum = w.reduce(function (a, b) { return a + b }, 0)
  el.title =
    "总分 = (词汇×" + w[0] + " + 发音×" + w[1] + " + 长度×" + w[2] + ") / " + sum +
    "；≥ " + bands[0] + " 中级、≥ " + bands[1] + " 高级、≥ " + bands[2] + " 专家"
  // ⚠️ 三个维度各自的权重同样从服务端读（别再在 HTML 里写死「权重 5 / 3 / 2」）
  Array.prototype.forEach.call(document.querySelectorAll('.meta-list .hint[data-w]'), function (h) {
    const base = h.dataset.base || ""
    const wi = Number(h.dataset.w)
    h.title = Number.isFinite(wi) && w[wi] !== undefined ? base + "（权重 " + w[wi] + "）" : base
  })
}

async function loadDetail(id) {
  errBox("#detail-error", "")
  $("#detail-body").hidden = true
  stopDetailAudio()
  try {
    const d = await api("/api/articles/" + id)
    applyServerConsts(d)
    state.detail = d
    fillDetail(d)
  } catch (e) {
    // ⚠️ 顺带把栈留在 data 属性里：本地工具没人开控制台，但排查时要看得到
    console.error("[admin] 详情渲染失败", e)
    errBox("#detail-error", e.message + "（栈见该节点的 data-stack）")
    $("#detail-error").dataset.stack = String((e && e.stack) || "")
  }
}

/** 取值：**未提交的改动优先于服务端** —— 刷新后看起来还是你改过的样子 */
function pick(field, serverValue) {
  return Object.prototype.hasOwnProperty.call(state.pending, field) ? state.pending[field] : serverValue
}

/**
 * 当前生效的三个判据分（编辑中的优先）；不是完整的 1–5 三元组就是 null。
 * ⚠️ 三个分是**一组**：改其中一档时另外两档沿用当前值（见 openInlineEditor 的 s1/s2/s3）。
 */
function curScores() {
  const s = pick("scores", state.detail && state.detail.scores)
  if (!Array.isArray(s) || s.length !== 3) return null
  for (let i = 0; i < 3; i++) {
    const n = Number(s[i])
    if (!Number.isFinite(n) || n < 1 || n > 5) return null
  }
  return s
}

function fillDetail(d) {
  $("#detail-body").hidden = false

  /**
   * ⭐ 朗读卡用**内容主题**的配色（浅底 + 深字，shared/theme.ts 的确定性配色）。
   * ⚠️ 服务端已经把 null 解析成 themeFromHash(id) 了 —— 浏览器端拿不到 @jushuo/shared
   *    （那是 TS），配色算法只允许一份实现，所以不许在这里重算。
   */
  const theme = d.theme || {}
  const card = $("#dt-card")
  card.style.background = theme.background || ""
  card.style.color = theme.foreground || ""

  $("#dt-text").textContent = d.text || "（本机仓库里没有这条正文）"
  $("#dt-id").textContent = d.id

  // ⭐ 先把本地草稿摊进 state.pending，再按「草稿优先」渲染（刷新不丢改动）
  state.pending = {}
  const draft = readDraft(d.id)
  if (draft) {
    Object.keys(draft).forEach(function (k) { state.pending[k] = draft[k] })
  }
  renderDetailValues(d)

  const a = $("#dt-audio")
  a.src = "/api/audio/" + d.id + ".mp3?t=" + Date.now()
  renderDetailPlay()
  renderDetailTime()
  renderUpdateButton()

  const tip = $("#dt-draft-tip")
  tip.hidden = !draft
  tip.textContent = draft
    ? "⚠️ 这条有未提交的改动（存在这台机器的 localStorage 里，刷新不会丢）—— 点「更新」提交，或「恢复」回到线上那份。"
    : ""
}

/**
 * 只重画「值」，不重建整页 —— 行内编辑提交后靠它回显。
 * ⚠️ 取值一律走 pick()：未提交的改动要盖过服务端返回的值。
 */
function renderDetailValues(d) {
  $("#dt-translation").textContent = pick("translation", d.translation) || "（还没有译文）"

  const live = pick("isActive", d.isActive === true || d.isActive === 1)
  const st = $("#dt-status")
  st.className = "badge " + (live ? "live" : "draft")
  st.textContent = live ? "已发布" : "草稿"

  /**
   * ⭐ 难度是**算出来**的：先看三个判据分（编辑中的优先），档位与加权分都从它推。
   *    ⚠️ 不直接显示 d.difficulty：手改过分数还没提交时，那句话会与下面三行矛盾。
   */
  const sc = curScores()
  const diff = diffFromScores(sc)
  /**
   * ⭐ 档位与总分**分两行显示**（用户 2026-09 的要求）：
   *    档位是给用户看的徽章，总分是内部量（阈值 2.5 / 3.5 / 4.5 才是它真正的作用）。
   *    挤在一行「中级（3.1）」会让人以为档位带小数。
   */
  $("#dt-diff").textContent = diff ? levelLabel(diff.difficulty) : "未定"
  $("#dt-score").textContent = diff ? diff.score.toFixed(1) : "—"
  const one = function (v) { return v === null || v === undefined || v === "" ? "未定" : String(v) }
  $("#dt-s1").textContent = one(sc && sc[0])
  $("#dt-s2").textContent = one(sc && sc[1])
  $("#dt-s3").textContent = one(sc && sc[2])
  /**
   * ⭐ 词表也走同一份「待提交」（对话框改完立刻回显）。
   *    ⚠️ 必须在这里重画：saveWordDialog 只改 state.detailWords + setPending，
   *       而 setPending 走的就是 renderDetailValues —— 不在这里画，用户要刷新页面才看得到改动。
   */
  const words = pick("words", d.words)
  state.detailWords = Array.isArray(words) ? words : []
  renderWordInfo($("#dt-words"), $("#dt-wordcount"), state.detailWords, d.links)

  /** ⭐ 给用户看的「朗读建议及收益」—— 运营就是照它审的（"读者读了会不会想张嘴"） */
  $("#dt-advice").textContent = pick("advice", d.advice) || "—"
  $("#dt-published").textContent = fmtTime(pick("publishedAt", d.publishedAt))

  /**
   * ⚠️⚠️ 先把数组取出来再遍历，**不要**写成
   *      tags.textContent = ""
   *      (tagList || []).forEach(...)
   *    —— 上一行以空字符串结尾、下一行以 `(` 开头时，ASI **不会**补分号，
   *    整句被解析成 `""(tagList || [])`：把空字符串当函数调用，
   *    报 `TypeError: "" is not a function`，而栈指向那个 `(` 所在的行。
   *    更坑的是它会让**后面所有语句都不执行**（按钮没挂上 handler）。
   */
  const tags = $("#dt-tags")
  const tagList = pick("tags", d.tags) || []
  tags.textContent = ""
  tagList.forEach(function (t) {
    const c = document.createElement("span")
    c.className = "chip"
    c.textContent = t
    tags.appendChild(c)
  })
}

/* ---- 行内编辑 + 一个统一的「更新」按钮 ---- */

function setPending(field, value) {
  state.pending[field] = value
  if (state.detail) {
    writeDraft(state.detail.id, { [field]: value })
    renderDetailValues(state.detail)
  }
  renderUpdateButton()
}

/** 有改动 → 亮起来；没改动 → 禁用（用户要的就是「一个按钮、有更新才亮」） */
function renderUpdateButton() {
  const n = Object.keys(state.pending).length
  const btn = $("#dt-update")
  btn.disabled = n === 0
  btn.textContent = n === 0 ? "更新" : "更新（" + n + " 项）"
  $("#dt-restore").hidden = n === 0
}

/**
 * 把值元素就地换成输入控件：回车/blur 提交，Esc 取消。
 *
 * ⚠️ 不 replaceWith 掉原元素（那样提交后就没东西可以回显了），
 *    而是**隐藏原元素 + 在它旁边插入输入框**，结束后把输入框删掉再显示原元素。
 * ⚠️ read() 返回 null = 「这个值不接受」—— 取消这次编辑并让调用方去 toast 说明原因。
 */
function startInlineEdit(valueEl, input, read, commit) {
  if (valueEl.__editing) return
  valueEl.__editing = true
  input.classList.add("inline-input")
  valueEl.hidden = true
  valueEl.parentElement.insertBefore(input, valueEl.nextSibling)

  /**
   * ⭐ 输入框后面只跟一个 **yes**。
   *
   * ⚠️ 为什么不需要 no：**失焦本身就是取消**（点输入框外面 / 点别处控件都会失焦），
   *    再放一个 no 是多余的第二条路（用户 2026-09 的决定）。
   *    回车 = yes；Esc / 失焦 = 取消。三条出口，各有各的自然触发方式。
   * ⚠️ yes 必须 **mousedown preventDefault**：否则点它会先让输入框失焦 →
   *    直接走「取消」分支，yes 永远点不生效（经典坑）。
   */
  const yes = document.createElement("button")
  yes.type = "button"
  yes.className = "inline-ok"
  yes.textContent = "yes"
  yes.title = "确定（回车）；点输入框外面 = 取消"
  yes.addEventListener("mousedown", function (e) { e.preventDefault() })

  let done = false
  const finish = function (ok) {
    if (done) return
    done = true
    valueEl.__editing = false
    if (ok) {
      const v = read(input)
      if (v !== null) commit(v)
    }
    input.remove()
    yes.remove()
    valueEl.hidden = false
  }
  yes.addEventListener("click", function () { finish(true) })
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true) }
    else if (e.key === "Escape") { e.preventDefault(); finish(false) }
  })
  input.addEventListener("blur", function () { finish(false) })
  // 提示挂到输入框上（没有 no 按钮了，得让人知道「点别处 = 取消」）
  input.title = (input.title ? input.title + " · " : "") + "回车确定，点别处取消"
  input.insertAdjacentElement("afterend", yes)
  input.focus()
  if (input.select) input.select()
}

function textInput(value) {
  const i = document.createElement("input")
  i.type = "text"
  i.value = value
  return i
}

function selectInput(options, value) {
  const s = document.createElement("select")
  options.forEach(function (o) {
    const opt = document.createElement("option")
    opt.value = o.v
    opt.textContent = o.t
    s.appendChild(opt)
  })
  s.value = String(value)
  return s
}

function openInlineEditor(field) {
  const d = state.detail
  if (!d || state.busy) return

  if (field === "translation") {
    const t = document.createElement("textarea")
    t.rows = 2
    t.value = pick("translation", d.translation) || ""
    startInlineEdit($("#dt-translation"), t, function (el) {
      const v = el.value.trim()
      if (!v) { toast("译文不能为空", true); return null }
      return v
    }, function (v) { setPending("translation", v) })
    return
  }

  if (field === "tags") {
    startInlineEdit($("#dt-tags"), textInput((pick("tags", d.tags) || []).join(" ")), function (el) {
      return parseTags(el.value)
    }, function (v) { setPending("tags", v) })
    return
  }

  /**
   * ⭐ 判据分（1–5）—— 三行各自可改，**没有「未定」**：档位是算出来的，
   *    缺一个分就没有档位，所以选项里不能有「空」。
   *    ⚠️ 改的是**整组**：只回传被改的那一档，另外两档沿用当前值（见 curScores）。
   */
  if (field === "s1" || field === "s2" || field === "s3") {
    const idx = { s1: 0, s2: 1, s3: 2 }[field]
    const cur = curScores() || [3, 3, 3]
    startInlineEdit(
      $("#dt-" + field),
      scoreSelect(cur[idx]),
      function (el) {
        const v = Number(el.value)
        if (!(v >= 1 && v <= 5)) return null
        const next = cur.slice()
        next[idx] = v
        return next
      },
      function (v) { setPending("scores", v) },
    )
    return
  }

  if (field === "advice") {
    // ⚠️ 给用户看的「朗读建议及收益」是**产品文案**，运营可以直接改（它要过人的眼）
    startInlineEdit(
      $("#dt-advice"),
      textInput(pick("advice", d.advice) || ""),
      function (el) { return el.value.trim() },
      function (v) { setPending("advice", v) },
    )
    return
  }

  if (field === "isActive") {
    const live = pick("isActive", d.isActive === true || d.isActive === 1)
    startInlineEdit(
      $("#dt-status"),
      selectInput([{ v: "1", t: "已发布" }, { v: "0", t: "草稿" }], live ? "1" : "0"),
      function (el) { return el.value === "1" },
      function (v) { setPending("isActive", v) },
    )
    return
  }

  /**
   * ⚠️ 发布时间**故意不做成可编辑**（用户 2026-09 的决定）：
   *    它答的是「这条是什么时候上的线」，只该由**草稿 → 发布**那一刻产生。
   *    能手改的话它就不再有这个含义了（而「最后一次编辑」是另一件事，
   *    真需要那个信息应该另加一列，不该复用这一列）。
   *    服务端也拒收 publishedAt（见 PUT 处理），所以这里连入口都不给。
   */
}

document.querySelectorAll("#view-detail .edit-icon").forEach(function (btn) {
  btn.addEventListener("click", function () { openInlineEditor(btn.getAttribute("data-field")) })
})

/**
 * 把所有**改过的**字段合成**一个** PUT。
 *
 * ⚠️ 只带改过的字段：不带 publish 就不动发布状态（服务端是三态），
 *    不带 words 就不动流水线产出的时间戳，不带 publishedAt 就走「草稿→发布才写」。
 * ⚠️ 服务端会校验（译文非空 / 区间条数与每项合法 / 时间合法），失败时
 *    **一个字段都不会写**，并原样报错 —— 所以这里不需要自己再拼一份校验。
 */
async function updateArticle() {
  const d = state.detail
  const p = state.pending
  if (!d || state.busy) return
  const keys = Object.keys(p)
  if (!keys.length) return
  if (Object.prototype.hasOwnProperty.call(p, "translation") && !String(p.translation).trim()) {
    toast("译文不能为空", true)
    return
  }
  state.busy = true
  errBox("#detail-error", "")
  const has = function (k) { return Object.prototype.hasOwnProperty.call(p, k) }
  const body = {}
  if (has("translation")) body.translation = p.translation
  if (has("scores")) body.scores = p.scores
  if (has("advice")) body.advice = p.advice
  if (has("tags")) body.tags = p.tags
  if (has("isActive")) body.publish = p.isActive
  if (has("words")) body.words = p.words
  try {
    await api("/api/articles/" + d.id, { method: "PUT", body: body })
    clearDraft(d.id)
    state.pending = {}
    toast("已更新 " + keys.length + " 项")
    await loadDetail(d.id)
    loadList()
  } catch (e) {
    errBox("#detail-error", e.message)
    toast(e.message, true)
  } finally {
    state.busy = false
  }
}

/** 恢复 = 丢掉攒下的改动，回到服务端当前的值（连本地草稿一起清掉） */
function restoreArticle() {
  const d = state.detail
  if (!d) return
  clearDraft(d.id)
  state.pending = {}
  toast("已恢复")
  loadDetail(d.id)
}

$("#dt-update").addEventListener("click", function () { updateArticle() })
$("#dt-restore").addEventListener("click", function () { restoreArticle() })

/* ---- 朗读卡里的整句播放按钮 ---- */

function fmtSec(s) {
  if (!isFinite(s) || s < 0) s = 0
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0")
}

function renderDetailPlay() {
  $("#dt-play").textContent = $("#dt-audio").paused ? "▶ 播放" : "⏸ 暂停"
}

function renderDetailTime() {
  const a = $("#dt-audio")
  $("#dt-time").textContent = fmtSec(a.currentTime) + " / " + fmtSec(a.duration)
}


async function toggleDetailPlay() {
  const a = $("#dt-audio")
  if (!a.getAttribute("src")) return
  if (!a.paused) { a.pause(); return }
  try {
    await a.play()
  } catch (e) {
    toast("这条还没有标准音，或音频读不到", true)
  }
  renderDetailPlay()
}

$("#dt-play").addEventListener("click", function () { toggleDetailPlay() })
$("#dt-audio").addEventListener("play", renderDetailPlay)
$("#dt-audio").addEventListener("pause", renderDetailPlay)
$("#dt-audio").addEventListener("timeupdate", renderDetailTime)
$("#dt-audio").addEventListener("loadedmetadata", renderDetailTime)
$("#dt-audio").addEventListener("ended", function () { renderDetailPlay(); renderDetailTime() })
function stopDetailAudio() {
  const a = $("#dt-audio")
  a.pause()
  renderDetailPlay()
  renderDetailTime()
}


/* ============================ 词表（只读） ============================ */

/**
 * ⭐ 渲染**词表**：一行一个词 —— 词（含句重音）｜ 音节 ｜ 音标 ｜ 句中义 ｜ 发音技巧，
 *    并在两行之间显示该词界的**连读技巧**。
 *
 * ⚠️⚠️ 这里以前是一张「逐词播放区间」表（每行两个可点改的时间戳 + 试听按钮）。
 *    随「点词播放改走微信 TTS」一起换掉了（2026-09）：正文里不再有时间戳、
 *    逐词音频也不存在，那张表没有数据可渲染了。
 * ⚠️ 词表是**派生数据**（由流水线按正文算出），这个台子**只展示、不改**：
 *    要改就改提示词/规则再整库重跑（pnpm content:regrade --apply）。
 */
function renderWordInfo(box, countEl, words, links) {
  if (countEl) countEl.textContent = String((words || []).length)
  box.textContent = ""
  if (!words || !words.length) {
    const li = document.createElement("li")
    li.className = "word-row muted tiny"
    li.textContent = "这条还没有词表（重新生成 / 重判一次就有了）。"
    box.appendChild(li)
    return
  }
  const STRESS = { 1: "重读", 0: "普通", "-1": "弱读" }
  words.forEach(function (w, i) {
    const li = document.createElement("li")
    li.className = "word-row"
    li.dataset.i = String(i)

    // 左列：单词 + 音标（音节单独一行，方便核对分拍对不对）
    const left = document.createElement("div")
    left.className = "wi-left"
    const text = document.createElement("b")
    text.className = "wi-text"
    text.textContent = w.text || ""
    left.appendChild(text)
    if (w.ipa) {
      const ipa = document.createElement("span")
      ipa.className = "wi-ipa"
      ipa.textContent = w.ipa
      left.appendChild(ipa)
    }
    if (Array.isArray(w.syllables) && w.syllables.length > 1) {
      const syl = document.createElement("span")
      syl.className = "wi-syl muted tiny"
      syl.textContent = w.syllables.join(" · ")
      left.appendChild(syl)
    }
    li.appendChild(left)

    // 中列：弱读 / 普通 / 重读
    const mid = document.createElement("div")
    mid.className = "wi-mid"
    const st = document.createElement("span")
    st.className = "wi-stress s" + String(w.stress)
    st.textContent = STRESS[String(w.stress)] || "?"
    mid.appendChild(st)
    li.appendChild(mid)

    // 右列：技巧（靠右）+ 编辑
    const right = document.createElement("div")
    right.className = "wi-right"
    const tip = document.createElement("span")
    tip.className = "wi-tip muted tiny"
    tip.textContent = [w.meaning ? "释义：" + w.meaning : "", w.tip || ""].filter(Boolean).join("；") || "—"
    right.appendChild(tip)
    const edit = document.createElement("button")
    edit.type = "button"
    edit.className = "edit-icon"
    edit.textContent = "✎"
    edit.title = "改这个词的音标 / 句重音 / 音节 / 释义 / 技巧"
    edit.addEventListener("click", function () { openWordDialog(i) })
    right.appendChild(edit)
    li.appendChild(right)

    box.appendChild(li)

    // ⭐ 连读技巧画在**两行之间** —— 它是两个词之间的关系，不是某一个词的属性
    const l = (links || [])[i]
    if (l) {
      const link = document.createElement("li")
      link.className = "link-row"
      link.textContent = "‿ " + l
      box.appendChild(link)
    }
  })
}

/* ============================ 改一个词的对话框 ============================ */

/**
 * ⭐ 打开「改这个词」对话框。
 *
 * ⚠️⚠️ 词表是流水线算出来的**派生数据**（音节/音标/句重音/技巧），但模型与规则都会出错 ——
 *    这是运营唯一能纠正它们的入口。改完和译文/难度一样：先攒进待提交，点底部「更新」才写盘。
 * ⚠️ `单词` 只读：它必须与正文切出来的那个词**一字不差**（下标要对齐评分引擎的逐词分数），
 *    改它就不是"改这个词的信息"而是"改正文"了（正文一改 id 就变）。
 */
function openWordDialog(i) {
  const w = state.detailWords[i]
  if (!w) return
  state.editWordIndex = i
  errBox("#wd-error", "")
  /**
   * ⚠️ 空字段**必须看起来是空的**：以前占位符写的是示例文案（"精致、考究（此句指格调）"），
   *    结果空值看起来像已经有值 —— 用户 2026-09 就是这么被误导的。
   *    现在占位符统一是「（空）」，字段含义写在标签旁边。
   */
  const weak = w.stress === -1
  $("#wd-hint").textContent =
    "第 " + (i + 1) + " 个词（下标必须与正文一致，所以单词本身不可改）" +
    (weak ? "；它是弱读的功能词，释义与技巧通常不必填" : "")
  $("#wd-text").value = w.text || ""
  $("#wd-ipa").value = w.ipa || ""
  $("#wd-stress").value = String(w.stress === undefined ? 0 : w.stress)
  $("#wd-syllables").value = (w.syllables || []).join(" ")
  $("#wd-meaning").value = w.meaning || ""
  $("#wd-tip").value = w.tip || ""
  $("#wd-dialog").showModal()
}

function saveWordDialog() {
  const i = state.editWordIndex
  const w = state.detailWords[i]
  if (!w) return
  const syllables = $("#wd-syllables").value.split(/\s+/).filter(Boolean)
  /**
   * ⚠️ 音节拼回来必须等于原词 —— 这是**不变量**（词表校验与 CI 都查它）。
   *    在这里就挡住，比存进文件再让 pnpm test 变红好：那时没人记得是谁改的。
   */
  if (syllables.join("") !== w.text) {
    errBox("#wd-error", "音节拼回来是「" + syllables.join("") + "」，原词是「" + w.text + "」——对不上")
    return
  }
  const next = state.detailWords.slice()
  next[i] = {
    text: w.text,
    stress: Number($("#wd-stress").value),
    syllables: syllables,
    ipa: $("#wd-ipa").value.trim(),
    meaning: $("#wd-meaning").value.trim(),
    tip: $("#wd-tip").value.trim(),
  }
  state.detailWords = next
  // ⭐ 与译文/难度共用一个「更新」按钮：词表也进待提交
  setPending("words", next)
  $("#wd-dialog").close()
  toast("已改「" + w.text + "」（点底部「更新」提交）")
}

$("#wd-cancel").addEventListener("click", function () { $("#wd-dialog").close() })
$("#wd-form").addEventListener("submit", function (e) { e.preventDefault(); saveWordDialog() })

/* ============================ 内容编辑抽屉 ============================ */

$("#add-btn").addEventListener("click", function () { openCreate() })
$("#ed-close").addEventListener("click", function () { closeEditor() })
$("#ed-split").addEventListener("click", function () { runSplit() })
$("#ed-ingest").addEventListener("click", function () { runIngest() })
$("#ed-publish").addEventListener("click", function () { publishSelected() })
$("#ed-toggle-all").addEventListener("click", function () { toggleAll("#ed-candidates") })
$("#ed-toggle-done").addEventListener("click", function () { toggleAll("#ed-ingested") })

/** 全选 / 全不选：只要还有没勾的就全勾上，否则全取消 */
function toggleAll(sel) {
  const boxes = [].slice.call(document.querySelectorAll(sel + " input[type=checkbox]:not(:disabled)"))
  const want = boxes.some(function (b) { return !b.checked })
  boxes.forEach(function (b) { b.checked = want })
}

/**
 * 云环境的提醒。
 *
 * ⚠️⚠️ 说清楚「哪些改动能生效」，因为**不生效的改动看起来完全正常**：
 *    客户端读的正文是**镜像里的** content/articles/*.json（Dockerfile COPY），
 *    库里的 articles 行只是索引 —— 所以：
 *      · 译文 / 难度 / 标签：对云环境**无效**（下次部署的 reindexArticles 还会覆盖回去）；
 *      · 发布 / 下架：写库里的 isActive，**有效**且不会被部署覆盖；
 *      · 新句子的正文与音频：要等一次部署才到客户端，在那之前它已经进了库、会被抽中排期。
 */
function renderEnvWarn() {
  const node = $("#ed-env-warn")
  if (state.env === "local") { node.hidden = true; return }
  node.hidden = false
  node.textContent =
    "⚠️ 当前是 " + state.env + "：客户端读的正文和音频都在镜像里，不在库里。所以 —— " +
    "译文 / 难度 / 标签在这里改不会影响 " + state.env + "（下次部署还会按镜像里的 JSON 覆盖回去）；" +
    "能可靠生效的是「发布 / 下架」。新句子的正文要跑一次 deploy-cloud.mjs " + state.env +
    " 之后才读得到，在那之前它已经进了库、会被抽中排期。"
}

/** 只负责「把抽屉打开」；内容由 openCreate 准备（抽屉只用于新增） */
function openEditorShell() {
  $("#editor").hidden = false
  errBox("#ed-error", "")
  renderEnvWarn()
}

function closeEditor() {
  $("#editor").hidden = true
}

/**
 * ⭐ 抽屉是**批量入库**的三步：① 拆分 → ② 勾选/手改后生成 → ③ 勾选后发布。
 *
 * ⚠️ 三步刻意分开，不在一条龙里跑完：**TTS 是唯一按量花钱的一步**，
 *    要放在人看过「拆得对不对」之后（理由见 spec.md 第九节）。
 */
function openCreate() {
  state.editorMode = "create"
  $("#ed-title").textContent = "新增句子（批量）"
  $("#ed-text").value = ""
  $("#ed-log").textContent = ""
  $("#ed-log").hidden = true
  $("#ed-candidates").textContent = ""
  $("#ed-ingested").textContent = ""
  $("#ed-step2").hidden = true
  $("#ed-step3").hidden = true
  $("#ed-split").disabled = false
  openEditorShell()
  $("#ed-text").focus()
}

/**
 * ⚠️ 抽屉**只服务「新增句子」**（用户 2026-09 的决定）：
 *    编辑已经全部挪到句子详情页的行内编辑 + 一个「更新」按钮上，
 *    所以这里没有 openEdit。
 */
/**
 * ⭐ 填一个**判据分**下拉（1–5）—— 没有「未定」：档位由分数算出，缺一分就没档位。
 * ⚠️ 刻度与文案（"1 分"…"5 分"）只在这里；标签映射走 levelLabel（服务端下发）。
 */
function scoreSelect(value) {
  const sel = document.createElement("select")
  // ⚠️ 不要写成 `[1,2,3,4,5].forEach(...)` 紧跟在赋值后面：ASI 不补分号，
  //    会被解析成 sel.appendChild(...)[1,2,3,4,5]（下标访问 + 逗号运算符）。
  const scores = [1, 2, 3, 4, 5]
  scores.forEach(function (n) {
    const o = document.createElement("option")
    o.value = String(n)
    o.textContent = n + " 分"
    sel.appendChild(o)
  })
  const v = Number(value)
  sel.value = String(v >= 1 && v <= 5 ? v : 3)
  return sel
}

function parseTags(raw) {
  return String(raw || "")
    .split(/[,，、\s]+/)
    .map(function (s) { return s.trim() })
    .filter(Boolean)
    .slice(0, 8)
}

/**
 * ⚠️ 排期**刻意不做在句子详情里**（用户 2026-09 的决定）：
 *    句子详情 = 这一句内容本身（正文/译文/难度/标签/发布状态），
 *    排期是「哪一天展示哪一句」，是另一个层面的运营动作，混在一起会让人
 *    以为「发布」和「排上某天」是同一件事。
 *    服务端的 `POST /api/articles/:id/schedule` 仍然在（脚本/将来独立入口可用），
 *    自动轮转（scheduleAhead）也完全不受影响。
 */


function logLine(msg) {
  const node = $("#ed-log")
  node.hidden = false
  node.textContent += (node.textContent ? "\n" : "") + msg
  node.scrollTop = node.scrollHeight
}

/** 轮询一个后台任务，把新增的日志打进面板；返回结束时的 job */
async function pollJob(jobId) {
  let seen = 0
  let lastStep = ""
  for (;;) {
    const job = await api("/api/jobs/" + jobId)
    if (Array.isArray(job.log)) {
      job.log.slice(seen).forEach(function (l) { logLine(l) })
      seen = job.log.length
    }
    if (job.status === "done") { logLine("✅ " + job.step); return job }
    if (job.status === "error") throw new Error(job.error || "任务失败")
    if (job.step && job.step !== lastStep) { logLine("… " + job.step); lastStep = job.step }
    await sleep(900)
  }
}

/** ⭐ ① 拆分 + 纠错（只调 LLM，不生成音频、不落盘） */
async function runSplit() {
  if (state.busy) return
  const text = $("#ed-text").value.trim()
  if (!text) { errBox("#ed-error", "先贴英文"); return }
  state.busy = true
  errBox("#ed-error", "")
  $("#ed-split").disabled = true
  $("#ed-log").textContent = ""
  $("#ed-log").hidden = false
  $("#ed-step2").hidden = true
  $("#ed-step3").hidden = true
  try {
    const start = await api("/api/split", { method: "POST", body: { text: text } })
    logLine("任务 " + start.jobId.slice(0, 8) + " 已开跑…")
    const job = await pollJob(start.jobId)
    renderCandidates(job.result)
  } catch (e) {
    errBox("#ed-error", e.message)
    logLine("❌ " + e.message)
  } finally {
    state.busy = false
    $("#ed-split").disabled = false
  }
}

/** 一条候选：勾选 + 正文（可改）+ 译文 + 三个判据分（档位实时算）+ 标签 + 那句话 */
function candidateRow(it) {
  const li = document.createElement("li")
  li.className = "cand"

  const head = document.createElement("div")
  head.className = "cand-head"
  const cb = document.createElement("input")
  cb.type = "checkbox"
  cb.className = "cand-check"
  // ⚠️ 已存在的默认**不勾**：它本来就会被跳过，勾上没有意义
  cb.checked = !it.exists
  head.appendChild(cb)
  const a = document.createElement("a")
  a.href = "/article/" + it.id
  a.className = "mono tiny"
  a.textContent = it.id
  head.appendChild(a)
  if (it.exists) {
    const b = document.createElement("span")
    b.className = "badge"
    b.textContent = "已存在 · 生成时跳过"
    head.appendChild(b)
  }
  li.appendChild(head)

  const text = document.createElement("textarea")
  text.rows = 2
  text.className = "cand-text"
  text.value = it.text
  li.appendChild(text)

  const tr = document.createElement("textarea")
  tr.rows = 2
  tr.className = "cand-tr"
  tr.value = it.translation || ""
  li.appendChild(tr)

  const row = document.createElement("div")
  row.className = "row"
  const mk = function (label, el) {
    const lb = document.createElement("label")
    lb.className = "block"
    lb.textContent = label
    lb.appendChild(el)
    return lb
  }
  /**
   * ⭐ 三个判据分（1–5），右边的档位是**实时算出来的** —— 用的权重与阈值
   *    就是服务端下发的那一份（入库时服务端还会再算一次，两处同源）。
   *    ⚠️ 没有「未定」：档位由这三个分算出，缺一个就没档位，选项里就不能有空。
   */
  const picks = []
  const diffLabel = document.createElement("span")
  diffLabel.className = "cand-diff-label"
  const refreshDiff = function () {
    const r = diffFromScores(picks.map(function (s) { return Number(s.value) }))
    diffLabel.textContent = r ? levelLabel(r.difficulty) + " " + r.score.toFixed(1) : ""
  }
  SCORE_NAMES.forEach(function (name, i) {
    const sel = scoreSelect(it.scores ? it.scores[i] : 3)
    sel.className = "cand-s" + (i + 1)
    sel.addEventListener("change", refreshDiff)
    picks.push(sel)
    row.appendChild(mk(name, sel))
  })
  refreshDiff()
  row.appendChild(diffLabel)
  const tags = document.createElement("input")
  tags.type = "text"
  tags.className = "cand-tags grow"
  tags.value = (it.tags || []).join(" ")
  row.appendChild(mk("标签", tags))
  li.appendChild(row)

  const advice = document.createElement("input")
  advice.type = "text"
  advice.className = "cand-advice"
  advice.value = it.advice || ""
  advice.placeholder = "怎么读 + 读完得着什么（口语收益）"
  li.appendChild(advice)

  /**
   * ⚠️⚠️ 候选整条挂回 DOM 节点上 —— 因为 **meanings 是模型给的、界面上不可编辑**，
   *    collectCandidates 读不回来（它只读 input 的 value）。
   *    以前那里写的是自由变量 `it`：**ReferenceError**，一点「生成」就炸
   *    （隐藏得深，因为不勾任何候选时根本走不到那行）。
   */
  li.candidate = it

  return li
}

function renderCandidates(result) {
  const items = (result && result.items) || []
  const box = $("#ed-candidates")
  box.textContent = ""
  items.forEach(function (it) { box.appendChild(candidateRow(it)) })
  $("#ed-cand-count").textContent = String(items.length)
  const skip = items.filter(function (it) { return it.exists }).length
  $("#ed-skip-note").textContent = skip ? "其中 " + skip + " 条已存在，生成时会跳过（不花钱）" : ""
  $("#ed-step2").hidden = items.length === 0
  if (items.length === 0) errBox("#ed-error", "没拆出任何句子 —— 输入是英文吗？")
  else logLine("拆出 " + items.length + " 条，默认已勾选" + (skip ? "（" + skip + " 条已存在）" : ""))
}

/** 收集勾选的候选 —— **以界面上的文本为准**（人可能改过；服务端还会按 text 重算 id） */
function collectCandidates() {
  const out = []
  ;[].slice.call(document.querySelectorAll("#ed-candidates .cand")).forEach(function (li) {
    if (!li.querySelector(".cand-check").checked) return
    out.push({
      text: li.querySelector(".cand-text").value.trim(),
      translation: li.querySelector(".cand-tr").value.trim(),
      // ⚠️ 三个下拉都没有空选项 ⇒ 这里恒是 1–5 的三个整数
      scores: [1, 2, 3].map(function (_, i) { return Number(li.querySelector(".cand-s" + (i + 1)).value) }),
      tags: parseTags(li.querySelector(".cand-tags").value),
      advice: li.querySelector(".cand-advice").value.trim(),
      /**
       * ⭐ 句中释义**原样带回**：词表（音节/音标/重音/连读）由服务端按**最终正文**重算，
       *    只有释义是模型给的、重算不出来。少带它不会报错，但新句子会没有释义。
       */
      meanings: (li.candidate && li.candidate.meanings) || [],
    })
  })
  return out.filter(function (it) { return it.text !== "" })
}

/** ⭐ ② 生成入库（草稿）—— 服务端按「先落正文 → 再批量 TTS → 最后入库」跑 */
async function runIngest() {
  if (state.busy) return
  const items = collectCandidates()
  if (items.length === 0) { errBox("#ed-error", "先勾选至少一条"); return }
  state.busy = true
  errBox("#ed-error", "")
  $("#ed-ingest").disabled = true
  try {
    const start = await api("/api/ingest", { method: "POST", body: { items: items } })
    logLine("任务 " + start.jobId.slice(0, 8) + " 已开跑…")
    const job = await pollJob(start.jobId)
    renderIngested(job.result)
  } catch (e) {
    errBox("#ed-error", e.message)
    logLine("❌ " + e.message)
  } finally {
    state.busy = false
    $("#ed-ingest").disabled = false
  }
}

function ingestedRow(it) {
  const li = document.createElement("li")
  li.className = "done"
  li.setAttribute("data-id", it.id)
  const cb = document.createElement("input")
  cb.type = "checkbox"
  cb.className = "done-check"
  // ⚠️ 只有真入库的才能勾（跳过 / 失败的没什么可发布）
  cb.disabled = it.status !== "done"
  cb.checked = it.status === "done"
  li.appendChild(cb)
  const a = document.createElement("a")
  a.href = "/article/" + it.id
  a.className = "mono tiny"
  a.textContent = it.id
  li.appendChild(a)
  const st = document.createElement("span")
  st.className = "badge " + (it.status === "done" ? "draft" : "")
  st.textContent = it.status === "done" ? "草稿"
    : it.status === "skipped" ? "已存在 · 跳过" : "失败：" + (it.error || "未知")
  li.appendChild(st)
  const t = document.createElement("div")
  t.className = "en tiny"
  t.textContent = it.text
  li.appendChild(t)
  return li
}

function renderIngested(result) {
  const items = (result && result.items) || []
  const box = $("#ed-ingested")
  box.textContent = ""
  items.forEach(function (it) { box.appendChild(ingestedRow(it)) })
  const done = items.filter(function (x) { return x.status === "done" }).length
  $("#ed-done-count").textContent = String(done)
  $("#ed-step3").hidden = items.length === 0
  logLine("本次：" + done + " 条入库 · 跳过 " + (result.skipped || 0) +     " 条（已存在，省了生成）· 失败 " + (result.failed || 0) + " 条")
  loadList()
}

/** ⭐ ③ 批量发布（只改库里的发布位） */
async function publishSelected() {
  if (state.busy) return
  const ids = []
  ;[].slice.call(document.querySelectorAll("#ed-ingested .done")).forEach(function (li) {
    if (li.querySelector(".done-check").checked) ids.push(li.getAttribute("data-id"))
  })
  if (ids.length === 0) { errBox("#ed-error", "先勾选要发布的条目"); return }
  state.busy = true
  errBox("#ed-error", "")
  try {
    const r = await api("/api/publish", { method: "POST", body: { ids: ids } })
    const okList = r.results.filter(function (x) { return x.ok })
    const bad = r.results.filter(function (x) { return !x.ok })
    okList.forEach(function (x) {
      const li = document.querySelector('#ed-ingested .done[data-id="' + x.id + '"]')
      if (!li) return
      const st = li.querySelector(".badge")
      st.className = "badge live"
      st.textContent = "已发布"
      li.querySelector(".done-check").checked = false
    })
    logLine("发布：" + okList.length + " 条成功" + (bad.length ? "，" + bad.length + " 条失败：" +
      bad.map(function (b) { return b.id + "(" + b.error + ")" }).join("、") : ""))
    toast("已发布 " + okList.length + " 条")
    loadList()
  } catch (e) {
    errBox("#ed-error", e.message)
  } finally {
    state.busy = false
  }
}





/**
 * ⚠️⚠️ 这里**曾经有 redoAudio()**（详情页那个「重做标准音」按钮 →
 *    POST /api/articles/:id/audio）—— 用户 2026-09 要求去掉：
 *    那个动作当年是为了**修逐词切片的坏区间**才需要的，而逐词音频已经不存在了
 *    （点词走微信 TTS）；整句音频坏了，重跑 `pnpm content:audio` 或直接重新生成更干净。
 *    服务端那个接口（runRegenerateAudio）也一起删了。
 */



/* ============================ 管理员账号 ============================ */

function renderAccount() {
  $("#acc-user").textContent = state.user || "—"
  $("#acc-env").textContent = ENV_LABEL[state.env] || state.env
  renderEnvStatus()
}

/* ============================ 启动 ============================ */

async function boot() {
  let s = null
  try { s = await api("/api/session") } catch (e) { s = null }
  if (s && s.authed) {
    state.authed = true
    state.user = s.user
    state.env = s.env
    // 归一化：/ 也当 /articles（列表是首页）
    if (location.pathname === "/") history.replaceState({}, "", "/articles")
    renderAuth()
    await afterLogin()
  } else {
    renderAuth()
    await loadLoginEnvs()
  }
}

boot()
