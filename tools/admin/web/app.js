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
    // ⭐ 标签映射来自服务端（shared/level.ts）—— 前端不再自己抄一份
    state.levelLabels = data.levelLabels || {}
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
    // ⭐ 两条轴分列显示：发音 / 词汇
    tr.appendChild(cell(levelLabel(row.pronLevel) + " / " + levelLabel(row.vocabLevel), "c-diff nowrap"))
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

async function loadDetail(id) {
  errBox("#detail-error", "")
  $("#detail-body").hidden = true
  stopDetailAudio()
  try {
    const d = await api("/api/articles/" + id)
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
  state.detailWords = Array.isArray(state.pending.words)
    ? state.pending.words
    : Array.isArray(d.words)
      ? d.words
      : []

  renderDetailValues(d)

  const a = $("#dt-audio")
  a.src = "/api/audio/" + d.id + ".mp3?t=" + Date.now()
  renderWords($("#dt-words"), $("#dt-wordcount"), state.detailWords, a, function () {
    // 词级区间也并入同一份「待提交」—— 和译文/难度/标签共用一个「更新」
    setPending("words", state.detailWords)
  })
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

  // ⭐ 两条轴分别显示（编辑中的值优先，见 pick）
  $("#dt-pron").textContent = levelLabel(pick("pronLevel", d.pronLevel))
  $("#dt-vocab").textContent = levelLabel(pick("vocabLevel", d.vocabLevel))
  /** ⭐ 给用户看的那句话 —— 运营就是照它审的（"读者能不能看懂这句难在哪"） */
  $("#dt-reason").textContent = pick("reason", d.reason) || "—"
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

  if (field === "pronLevel" || field === "vocabLevel") {
    const cur = pick(field, d[field])
    // ⚠️ 只给四档、没有「未定」：正文 JSON 里的档位必须是 0–3 之一
    //    （content-files.test.ts 会查），存不了「未定」就别把它做成选项。
    const levels = [0, 1, 2, 3].map(function (n) { return { v: String(n), t: levelLabel(n) } })
    startInlineEdit(
      field === "pronLevel" ? $("#dt-pron") : $("#dt-vocab"),
      selectInput(levels, cur === null || cur === undefined ? "0" : String(cur)),
      function (el) { return Number(el.value) },
      function (v) { setPending(field, v) },
    )
    return
  }

  if (field === "reason") {
    // ⚠️ 给用户看的一句话是**产品文案**，运营可以直接改（它要过人的眼）
    startInlineEdit(
      $("#dt-reason"),
      textInput(pick("reason", d.reason) || ""),
      function (el) { return el.value.trim() },
      function (v) { setPending("reason", v) },
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
  if (has("pronLevel")) body.pronLevel = p.pronLevel
  if (has("vocabLevel")) body.vocabLevel = p.vocabLevel
  if (has("reason")) body.reason = p.reason
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
$("#dt-redo").addEventListener("click", function () { redoAudio() })

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

/**
 * 清掉「点词播放」留下的定时器与高亮。
 *
 * ⚠️ 点词播放会挂一个「到 endMs 就 pause」的定时器。用户紧接着点「播放整句」时，
 *    那个定时器还在跑 —— 几百毫秒后它会把整句播放 **pause 掉**，
 *    看起来就像「播放按钮坏了 / 播一下就停」。所以用户主动播整句前必须先清掉它。
 */
function stopWordPlay(audio, box) {
  endWordPlayback(audio)
  if (box) {
    box.querySelectorAll(".word-row.on").forEach(function (r) { r.classList.remove("on") })
  }
}

async function toggleDetailPlay() {
  const a = $("#dt-audio")
  if (!a.getAttribute("src")) return
  if (!a.paused) { a.pause(); return }
  stopWordPlay(a, $("#dt-words"))
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
// 正在播的那一行画进度（详情页 / 抽屉共用）
$("#dt-audio").addEventListener("timeupdate", function () { progressOf($("#dt-audio")) })
$("#ed-audio").addEventListener("timeupdate", function () { progressOf($("#ed-audio")) })
$("#dt-audio").addEventListener("ended", function () { renderDetailPlay(); renderDetailTime() })
function stopDetailAudio() {
  const a = $("#dt-audio")
  stopWordPlay(a, $("#dt-words"))
  a.pause()
  renderDetailPlay()
  renderDetailTime()
}

/* ============================ 词级播放（详情页 / 抽屉共用） ============================ */

/**
 * 渲染分词列表：一行一个词 —— 词 ｜ [起] - [止] ｜ 试听。
 *
 * ⭐ 时间可以**点开就地改**（见 startTimeEdit）：引擎对弱读虚词（the/to/is）给的
 *    边界经常落在停顿上，自动规则兜不住每一个，得留一条人工修正的路。
 * ⚠️ 改完必须保存（onChange 让调用方把「保存」亮出来）—— 否则刷新就回来了。
 * ⚠️ 区间是**播放区间**（词中点夹取 + 最小 300ms），与小程序 reading 页同一套，
 *    所以这里「点词听到的」和真机上听到的是同一段。
 */
function renderWords(box, countEl, words, audio, onChange) {
  if (countEl) countEl.textContent = String((words || []).length)
  box.textContent = ""
  if (!words || !words.length) {
    const li = document.createElement("li")
    li.className = "word-row muted tiny"
    li.textContent = "这条还没有词级时间戳（重新生成一次就有了）。"
    box.appendChild(li)
    return
  }
  words.forEach(function (w, i) {
    const li = document.createElement("li")
    li.className = "word-row"
    li.dataset.i = String(i)

    const text = document.createElement("span")
    text.className = "w-text"
    text.textContent = w.word

    const time = document.createElement("span")
    time.className = "w-time"
    time.appendChild(timeButton(box, countEl, words, audio, onChange, i, "startMs"))
    const dash = document.createElement("span")
    dash.className = "muted"
    dash.textContent = "-"
    time.appendChild(dash)
    time.appendChild(timeButton(box, countEl, words, audio, onChange, i, "endMs"))

    const play = document.createElement("button")
    play.type = "button"
    play.className = "play"
    play.textContent = "▶"
    play.title = "试听这个词"
    play.addEventListener("click", function () { playWordAt(audio, box, words, i) })

    const bar = document.createElement("span")
    bar.className = "w-bar"
    const fill = document.createElement("i")
    bar.appendChild(fill)

    li.appendChild(text)
    li.appendChild(time)
    li.appendChild(play)
    li.appendChild(bar)
    box.appendChild(li)
  })
}

function timeButton(box, countEl, words, audio, onChange, i, key) {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "t"
  btn.textContent = "[" + fmtStamp(words[i][key]) + "]"
  btn.title = "点一下改这个时间（支持 00:01.590 ／ 1.590 秒 ／ 1590 毫秒）"
  btn.addEventListener("click", function () {
    startTimeEdit(btn, box, countEl, words, audio, onChange, i, key)
  })
  return btn
}

/** 毫秒 → 00:01.590 */
function fmtStamp(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0))
  const p = function (n, w) { return String(n).padStart(w, "0") }
  return p(Math.floor(t / 60000), 2) + ":" + p(Math.floor((t % 60000) / 1000), 2) + "." + p(t % 1000, 3)
}

/**
 * 解析人工输入的时间。三种写法都收：
 *   00:01.590 → 分:秒.毫秒   1.590 → 秒   1590 → 毫秒（纯整数按毫秒，库里存的就是毫秒）
 * 看不懂返回 null —— 调用方报错，**不猜**（猜错的后果是点词播到别的地方去）。
 */
function parseStamp(text) {
  const raw = String(text || "").trim().replace(/^\[|\]$/g, "")
  if (!raw) return null
  const mmss = /^(\d+):(\d+(?:\.\d+)?)$/.exec(raw)
  if (mmss) return Math.round((Number(mmss[1]) * 60 + Number(mmss[2])) * 1000)
  if (/^\d+\.\d+$/.test(raw)) return Math.round(Number(raw) * 1000)
  if (/^\d+$/.test(raw)) return Number(raw)
  return null
}

/** 点时间 → 就地变输入框。回车确定、Esc 取消、失焦也算确定；改完顺手播一次 */
function startTimeEdit(btn, box, countEl, words, audio, onChange, i, key) {
  const input = document.createElement("input")
  input.className = "t-input"
  input.value = fmtStamp(words[i][key])
  input.title = "支持 00:01.590 ／ 1.590（秒）／ 1590（毫秒）"
  input.title = "支持 00:01.590 ／ 1.590（秒）／ 1590（毫秒）"
  /**
   * ⭐ 和 dl 里的行内编辑**同一套**：输入框 + yes / no。
   * ⚠️ 不再放「按输入值试听」的 ▶（用户 2026-09 的决定）：那个按钮是多余的 ——
   *    先 yes 提交、再点这一行的 ▶，语义更清楚，而且提交后的那次自动预览本来就会响。
   * ⚠️ 值先进**本地缓存**（onChange → setPending → localStorage），
   *    只有点底部「更新」才同步到服务端。
   */
  startInlineEdit(btn, input, function (el) {
    const ms = parseStamp(el.value)
    if (ms === null) {
      toast("时间看不懂：" + el.value + "（可用 00:01.590 / 1.590 / 1590）", true)
      return null
    }
    return ms
  }, function (ms) {
    words[i][key] = ms
    if (typeof onChange === "function") onChange()
    renderWords(box, countEl, words, audio, onChange)
    // 提交后播一次：改对没有，耳朵比眼睛快（这一次是真人的点击触发的，不受自动播放策略影响）
    playWordAt(audio, box, words, i)
  })
}

/**
 * ⚠️⚠️ 必须先等到**元数据**再定位，否则点任何词都在播句子开头。
 *
 *    <audio> 在 readyState = 0（还没拿到 metadata）时给 currentTime 赋值会被
 *    **直接忽略**：不报错、不生效，接着 play() 就从 0 秒开始。
 *    症状正是「每个词都从 0 秒起播」——而且看起来像「分词功能没做」。
 *    小程序那边对应的是 startTime（见 lib/audio/play.ts 的 startSegment），
 *    它同样带一次「补 seek」，两边的阈值也保持一致（0.05s）。
 */
function waitMetadata(audio) {
  if (audio.readyState >= 1) return Promise.resolve()
  return new Promise(function (resolve) {
    let done = false
    const finish = function () {
      if (done) return
      done = true
      audio.removeEventListener("loadedmetadata", finish)
      resolve()
    }
    audio.addEventListener("loadedmetadata", finish)
    // ⚠️ 兜底：加载失败也要放行，否则这一次点击会永远卡住
    setTimeout(finish, 1500)
    try { audio.load() } catch (e) { /* ignore */ }
  })
}

/** ⭐ 播一个词的区间（点这一行的 ▶、或改完时间自动预览，都走这里） */
async function playWordAt(audio, box, words, i) {
  const w = words[i]
  if (!audio || !w || typeof w.startMs !== "number" || typeof w.endMs !== "number") return
  const rows = box.querySelectorAll(".word-row")
  const clear = function () { endWordPlayback(audio) }
  clearTimeout(audio.__stop)
  clearTimeout(audio.__resync)

  const start = Math.max(0, w.startMs / 1000)
  const end = Math.max(start + 0.15, w.endMs / 1000)

  await waitMetadata(audio)
  try { audio.currentTime = start } catch (e) { /* 还不可 seek，下一步补 */ }
  audio.__playing = { box: box, i: i, startMs: w.startMs, endMs: w.endMs }
  progressOf(audio)
  /**
   * ⚠️ 光靠 `timeupdate` 不够：它约 250ms 才跳一次，而一个词可能只有 300ms
   *    （MIN_PLAY_SEC）—— 那样整段播完进度条一次都不动。这里自己按 60ms 推。
   */
  clearInterval(audio.__tick)
  audio.__tick = setInterval(function () { progressOf(audio) }, 60)
  const p = audio.play()
  if (p && p.catch) {
    p.catch(function (err) {
      /**
       * ⚠️⚠️ 这里**绝不能静默**：浏览器拦下自动播放时（NotAllowedError），
       *    表现就是「改完时间什么都没发生」—— 而用户完全不知道是为什么。
       *    （实测的教训：本来写的是空 catch，于是这条路上一点线索都没有。）
       */
      toast("浏览器拦下了自动播放（" + ((err && err.name) || "未知") + "）—— 点这一行的 ▶ 试听", true)
      clear()
    })
  }

  /**
   * ⚠️ 再核一次：首帧有可能把这次 seek 丢掉。
   *    不补的话听到的是句子开头 —— 那是**错的**，比「不准」更糟。
   */
  audio.__resync = setTimeout(function () {
    if (Math.abs(audio.currentTime - start) > 0.05) {
      try { audio.currentTime = start } catch (e) { /* ignore */ }
    }
  }, 80)

  rows.forEach(function (r) { r.classList.toggle("on", Number(r.dataset.i) === i) })
  audio.__stop = setTimeout(function () { audio.pause(); clear() }, (end - start) * 1000 + 80)
}

/**
 * 正在播的那一行画一条进度 —— 只有声音的话，短词（300ms）听起来就是「响了一下」，
 * 看不出播的是哪一段、播到哪了。
 */
/**
 * 一次「点词播放」的收尾：清定时器、去掉高亮、进度条归零。
 *
 * ⚠️ 复位进度条必须**按正在播的那一行**去取：
 *    `box.querySelector(".word-row .w-bar i")` 命中第一行，会有「播第 5 个词、
 *    进度条却停在第一行 / 停在 50% 不动」这种假象（实测踩到）。
 */
function endWordPlayback(audio) {
  clearTimeout(audio.__stop)
  clearTimeout(audio.__resync)
  clearInterval(audio.__tick)
  const prev = audio.__playing
  if (prev) {
    const rows = prev.box.querySelectorAll(".word-row")
    rows.forEach(function (r) { r.classList.remove("on") })
    const row = rows[prev.i]
    const bar = row && row.querySelector(".w-bar i")
    if (bar) bar.style.width = "0%"
  }
  audio.__playing = null
}

function progressOf(audio) {
  const p = audio.__playing
  if (!p) return
  const row = p.box.querySelectorAll(".word-row")[p.i]
  const bar = row && row.querySelector(".w-bar i")
  if (!bar) return
  const span = Math.max(1, p.endMs - p.startMs)
  const pct = ((audio.currentTime * 1000 - p.startMs) / span) * 100
  bar.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%"
}

/* ============================ 内容编辑抽屉 ============================ */

$("#add-btn").addEventListener("click", function () { openCreate() })
$("#ed-close").addEventListener("click", function () { closeEditor() })
$("#ed-generate").addEventListener("click", function () { runGenerate() })
$("#ed-save").addEventListener("click", function () { saveArticle(false) })
$("#ed-publish").addEventListener("click", function () { saveArticle(true) })
$("#ed-tags").addEventListener("input", function () { renderTagChips() })

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
  const a = $("#ed-audio")
  stopWordPlay(a, $("#ed-words"))
  a.pause()
  $("#editor").hidden = true
  state.edit = null
  state.editWords = []
}

function openCreate() {
  state.editorMode = "create"
  state.edit = null
  state.editWords = []
  $("#ed-title").textContent = "新增句子"
  $("#ed-input").hidden = false
  $("#ed-fields").hidden = true
  $("#ed-log").hidden = true
  $("#ed-log").textContent = ""
  $("#ed-text").value = ""
  $("#ed-generate").disabled = false
  $("#ed-text-ro").value = ""
  $("#ed-translation").value = ""
  $("#ed-tags").value = ""
  $("#ed-id").textContent = ""
  $("#ed-status").textContent = ""
  $("#ed-words").textContent = ""
  $("#ed-audio").removeAttribute("src")
  $("#ed-audio-note").textContent = ""
  openEditorShell()
  $("#ed-text").focus()
}

/**
 * ⚠️ 抽屉**只服务「新增句子」**（用户 2026-09 的决定）：
 *    编辑已经全部挪到句子详情页的行内编辑 + 一个「更新」按钮上，
 *    所以这里没有 openEdit。
 */
/** 填一个档位下拉（两条轴共用；标签来自服务端，见 levelLabel） */
function fillLevelSelect(sel, value) {
  sel.textContent = ""
  const none = document.createElement("option")
  none.value = ""
  none.textContent = "未定"
  sel.appendChild(none)
  // ⚠️ 不要写成 `[0,1,2,3].forEach(...)`：上一行以 ) 结尾时 ASI 不补分号，
  //    会被解析成 sel.appendChild(none)[0,1,2,3].forEach(...)（下标访问 + 逗号运算符）。
  const levels = [0, 1, 2, 3]
  levels.forEach(function (n) {
    const o = document.createElement("option")
    o.value = String(n)
    o.textContent = levelLabel(n)
    sel.appendChild(o)
  })
  sel.value = value === null || value === undefined ? "" : String(value)
}

function fillFields(d) {
  state.edit = d
  state.editWords = Array.isArray(d.words) ? d.words : []
  $("#ed-id").textContent = "id " + d.id
  $("#ed-text-ro").value = d.text || ""
  $("#ed-translation").value = d.translation || ""
  $("#ed-tags").value = (d.tags || []).join(" ")
  fillLevelSelect($("#ed-pron"), d.pronLevel)
  fillLevelSelect($("#ed-vocab"), d.vocabLevel)
  $("#ed-reason").value = d.reason || ""
  audioSrc(d.id)
  renderTagChips()
  state.editWordsDirty = false
  renderWords($("#ed-words"), $("#ed-wordcount"), state.editWords, $("#ed-audio"), function () {
    state.editWordsDirty = true
  })
  renderStatus()
}

function audioSrc(id) {
  const a = $("#ed-audio")
  // ⚠️ 加时间戳破缓存：重做标准音后文件名不变（id 没变），不加这个可能还能播到旧的
  a.src = "/api/audio/" + id + ".mp3?t=" + Date.now()
  const note = $("#ed-audio-note")
  if (state.env === "local") {
    note.textContent = "读的是仓库里的 content/audio/" + id.slice(0, 12) + "….mp3"
  } else {
    note.textContent = "试听读的是**本机仓库**的文件；这条句子进了 " + state.env +
      " 的库，音频要等下一次部署（dev 靠 SEED_ON_START 灌桶）才会到对象存储。"
  }
}

function renderStatus() {
  const d = state.edit
  if (!d) return
  const live = d.isActive === true || d.isActive === 1
  $("#ed-status").textContent =
    "当前状态：" + (live ? "已发布" : "草稿") + "　环境：" + (ENV_LABEL[state.env] || state.env) +
    "　词数：" + state.editWords.length
}

function parseTags(raw) {
  return String(raw || "")
    .split(/[,，、\s]+/)
    .map(function (s) { return s.trim() })
    .filter(Boolean)
    .slice(0, 8)
}

function renderTagChips() {
  const box = $("#ed-tagchips")
  box.textContent = ""
  parseTags($("#ed-tags").value).forEach(function (t) {
    const c = document.createElement("span")
    c.className = "chip"
    c.textContent = t
    box.appendChild(c)
  })
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

async function runGenerate() {
  if (state.busy) return
  const text = $("#ed-text").value.trim()
  if (!text) { errBox("#ed-error", "先贴一句英文"); return }
  state.busy = true
  errBox("#ed-error", "")
  $("#ed-generate").disabled = true
  $("#ed-log").textContent = ""
  $("#ed-log").hidden = false
  try {
    const start = await api("/api/generate", { method: "POST", body: { text: text } })
    logLine("任务 " + start.jobId.slice(0, 8) + " 已开跑…")
    const job = await pollJob(start.jobId)
    onGenerated(job.result)
  } catch (e) {
    errBox("#ed-error", e.message)
    logLine("❌ " + e.message)
  } finally {
    state.busy = false
    $("#ed-generate").disabled = false
  }
}

function onGenerated(result) {
  state.editorMode = "create"
  $("#ed-input").hidden = true
  $("#ed-fields").hidden = false
  fillFields({
    id: result.id,
    text: result.text,
    translation: result.translation,
    pronLevel: result.pronLevel,
    vocabLevel: result.vocabLevel,
    reason: result.reason,
    tags: result.tags,
    isActive: false,
    words: result.words,
  })
  if (result.reason) logLine("这句话难在哪：" + result.reason)
  loadList()
  toast("生成完成，检查后点发布")
}

/** 保存 / 发布 / 下架。⚠️ 不带 publish 字段 = 保持现状（见服务端 upsertArticle 的三态） */
async function saveArticle(publish) {
  const d = state.edit
  if (!d || state.busy) return
  state.busy = true
  errBox("#ed-error", "")
  try {
    const body = {
      translation: $("#ed-translation").value.trim(),
      pronLevel: Number($("#ed-pron").value),
      vocabLevel: Number($("#ed-vocab").value),
      reason: $("#ed-reason").value.trim(),
      tags: parseTags($("#ed-tags").value),
    }
    if (publish) body.publish = true
    // ⚠️ 只在**改过**区间时才带上 words：普通保存不该回传整份时间戳
    //    （服务端会校验，条数/区间不对会直接报错而不是写坏文件）
    if (state.editWordsDirty) body.words = state.editWords
    await api("/api/articles/" + d.id, { method: "PUT", body: body })
    state.editWordsDirty = false
    if (publish) {
      d.isActive = true
      toast(state.env === "local" ? "已发布" : "已写入 " + state.env + " 的库；正文和音频要等部署")
    } else {
      toast(state.env === "local" ? "已保存" : "已保存（云环境读的是镜像里的正文，改动不生效）")
    }
    // 新增流程里发布完就落到这条的详情页（继续看词级播放、排期都顺手）
    if (publish && state.editorMode === "create") {
      closeEditor()
      navigate("/article/" + d.id)
      return
    }
    const fresh = await api("/api/articles/" + d.id)
    fillFields(fresh)
    loadList()
    if (parseRoute(location.pathname).view === "detail") loadDetail(d.id)
  } catch (e) {
    errBox("#ed-error", e.message)
    toast(e.message, true)
  } finally {
    state.busy = false
  }
}

/** 重做标准音：正文一个字不动，只重跑 fish 并刷新词级区间 */
/**
 * 重做这条句子的标准音（正文一个字不动，只重跑 fish 并刷新词级区间）。
 *
 * ⚠️ 这个入口从编辑抽屉搬到了详情页的分词列表上：它是**音频**的修复动作，
 *    而分词列表正是「听出来哪个词不对」的地方。
 */
async function redoAudio() {
  const d = state.detail
  if (!d || state.busy) return
  state.busy = true
  errBox("#detail-error", "")
  $("#dt-redo").disabled = true
  toast("重做标准音…")
  try {
    const start = await api("/api/articles/" + d.id + "/audio", { method: "POST", body: { force: true } })
    await pollJob(start.jobId)
    clearDraft(d.id)
    state.pending = {}
    await loadDetail(d.id)
    toast("标准音已重做")
  } catch (e) {
    errBox("#detail-error", e.message)
    toast(e.message, true)
  } finally {
    state.busy = false
    $("#dt-redo").disabled = false
  }
}



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
