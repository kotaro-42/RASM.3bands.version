// app.js
// =====================================
// RNBO Web Audio Device Setup
// =====================================

// パッチ初期化用のジグル中は UI 追従を止める（つまみが一瞬動くのを防ぐ）
let suppressParameterUiSync = false;

async function setup() {
    const patchURL = "export/rasm_origin.json";

    const WA = window.AudioContext || window.webkitAudioContext;
    const context = new WA();

    const out = context.createGain();
    out.connect(context.destination);

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const meterBuffer = new Float32Array(analyser.fftSize);

    let patcher;
    try {
        const res = await fetch(patchURL);
        patcher = await res.json();
        if (!window.RNBO) {
            await loadRNBOScript(patcher.desc.meta.rnboversion);
        }
    } catch (e) {
        console.error("Failed to load patcher:", e);
        return;
    }

    let device;
    try {
        device = await RNBO.createDevice({ context, patcher });
        window.rnboDevice = device;
        window.rnboContext = context;
    } catch (e) {
        console.error("Failed to create RNBO device:", e);
        return;
    }

    device.node.connect(analyser);
    analyser.connect(out);

    // Mic input
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mic = context.createMediaStreamSource(stream);
        mic.connect(device.node);
    } catch (e) {
        console.error("Microphone error:", e);
    }

    startMeterLoop(analyser, meterBuffer);

    // 呼び出し順
    connectCustomSliders(device);  // RNBO param <-> Slider
    connectSampleRateToggle(device);
    generateAllTicks();            // 各スライダーに ticks を DOM 生成

    // AudioContext 再開後に sensitivity をジグルしてパッチを初期化する
    let patchInitialized = false;
    const initPatch = () => {
        if (patchInitialized) return;
        patchInitialized = true;
        const p = device.parameters.find(x => x.name === "sensitivity");
        if (!p) return;
        const saved = p.value;
        suppressParameterUiSync = true;
        p.value = saved >= 1 ? saved - 1 : saved + 1;
        setTimeout(() => {
            p.value = saved;
            suppressParameterUiSync = false;
        }, 50);
    };

    // 自動起動を試みる（localhost など許可環境では即時起動）
    context.resume().then(initPatch);

    // ドラッグ開始も含む最初のユーザー操作で確実に起動
    document.body.addEventListener('pointerdown', () => {
        context.resume().then(initPatch);
    }, { once: true });
}



// =====================================
// RNBO script loader
// =====================================
function loadRNBOScript(version) {
    return new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = `https://c74-public.nyc3.digitaloceanspaces.com/rnbo/${version}/rnbo.min.js`;
        el.onload = resolve;
        el.onerror = () => reject(new Error("Failed to load rnbo.js"));
        document.body.append(el);
    });
}



// =====================================
// DOM ticks generator（シンプル版）
// =====================================
// steps = 区間数 → ticks = steps + 1
// 例：steps = 12 → 0〜12 の 13 本
function generateTicksFor(container, steps) {
    container.innerHTML = ""; // 一旦クリア

    if (!Number.isFinite(steps) || steps <= 0) return;

    const count = steps + 1;

    // 両端（0% / 100%）の目盛りは描画しない
    for (let i = 1; i < count - 1; i++) {
        const t = document.createElement("div");
        t.className = "tick";

        const pos = (i / steps) * 100; // 0〜100%
        t.style.left = pos + "%";

        container.appendChild(t);
    }
}

// 全 .slider-ticks に対して ticks を生成
function generateAllTicks() {
    document.querySelectorAll(".slider-ticks").forEach(ticks => {
        const steps = Number(ticks.dataset.steps);
        if (!Number.isFinite(steps) || steps <= 0) return;

        generateTicksFor(ticks, steps);
    });
}



// =====================================
// RNBO <-> Custom Slider Mapping
// =====================================

// UI だけの表示仕様。min/max/step/初期値は RNBO パラメータから取る
const UI_META = {
    volume:         { invert: false },
    sensitivity:    { invert: true },
    dynamics:       { invert: false },
    responsiveness: { invert: true },
    release:        { invert: false }
};

function stepFromRnboParam(p) {
    const min = Number(p.min);
    const max = Number(p.max);
    const steps = Number(p.steps);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (!Number.isFinite(steps) || steps <= 1) return 0;
    return (max - min) / (steps - 1);
}

function updateHorizontalFill(slider) {
    const container = slider.closest(".horizontal-slider-container");
    // Volume は実音量メーターを使うため、パラメータ塗りは適用しない
    if (!container || container.classList.contains("volume-slider-container")) return;

    const min = Number(slider.min);
    const max = Number(slider.max);
    const val = Number(slider.value);
    const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
    container.style.setProperty("--fill", `${pct}%`);
}

function syncAllHorizontalFills() {
    document.querySelectorAll(".horizontal-slider").forEach(updateHorizontalFill);
}

function connectCustomSliders(device) {
    const mapping = [
        { ui: "volume-slider",         param: "volume" },
        { ui: "sensitivity-slider",    param: "sensitivity" },
        { ui: "dynamics-slider",       param: "dynamics" },
        { ui: "responsiveness-slider", param: "responsiveness" },
        { ui: "release-slider",        param: "release" }
    ];

    mapping.forEach(({ ui, param }) => {
        const slider = document.getElementById(ui);
        const p = device.parameters.find(x => x.name === param);
        const meta = UI_META[param];
        if (!slider || !p || !meta) return;

        const min = Number(p.min);
        const max = Number(p.max);
        const step = stepFromRnboParam(p);

        // HTML の min/max/step も RNBO と合わせる
        slider.min = min;
        slider.max = max;
        if (step > 0) {
            slider.step = step;
        } else {
            slider.removeAttribute("step");
        }

        // Param → Slider
        const paramToSlider = (v) => {
            let val = Number(v);
            if (meta.invert) {
                val = max - val;
            }
            return val;
        };

        // Slider → Param
        const sliderToParam = (v) => {
            let raw = Number(v);
            if (meta.invert) {
                raw = max - raw;
            }

            if (step > 0) {
                raw = Math.round((raw - min) / step) * step + min;
            }

            if (raw < min) raw = min;
            if (raw > max) raw = max;

            return raw;
        };

        // 初期値反映：RNBO の値を UI に（システム側が単一ソース）
        slider.value = paramToSlider(p.value);
        updateHorizontalFill(slider);

        // UI → RNBO
        slider.addEventListener("input", (e) => {
            const v = parseFloat(e.target.value);
            const paramValue = sliderToParam(v);
            if (p.value !== paramValue) {
                p.value = paramValue;
            }
            updateHorizontalFill(slider);
        });

        // RNBO → UI（外部から param が変わったときも追従）
        device.parameterChangeEvent.subscribe(ev => {
            if (suppressParameterUiSync) return;
            if (ev.id !== p.id) return;
            slider.value = paramToSlider(ev.value);
            updateHorizontalFill(slider);
        });
    });
}

function connectSampleRateToggle(device) {
    const toggle = document.getElementById("samplerate-toggle");
    const p = device.parameters.find(x => x.name === "samplerate");
    if (!toggle || !p) return;

    // 44.1kHz スイッチ: ON=44.1kHz / OFF=48kHz（初期は OFF）
    const rate441 = Number(p.min);
    const rate48 = Number(p.max);
    const midpoint = (rate441 + rate48) / 2;

    const paramToChecked = (v) => Number(v) < midpoint;
    const checkedToParam = (checked) => (checked ? rate441 : rate48);

    toggle.checked = paramToChecked(p.value);

    toggle.addEventListener("change", () => {
        const next = checkedToParam(toggle.checked);
        if (p.value !== next) {
            p.value = next;
        }
    });

    device.parameterChangeEvent.subscribe(ev => {
        if (suppressParameterUiSync) return;
        if (ev.id !== p.id) return;
        toggle.checked = paramToChecked(ev.value);
    });
}

function startMeterLoop(analyser, buffer) {
    if (!analyser || !buffer) return;

    const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            const sample = buffer[i];
            sum += sample * sample;
        }
        const rms = Math.sqrt(sum / buffer.length);
        // 過大なクリップを避けるため少し持ち上げる
        const normalized = Math.min(1, rms * 10);
        // 見た目上は 3 倍。シリンダーを超える分は満タン表示
        updateMeter(Math.min(1, normalized * 3));
        requestAnimationFrame(tick);
    };

    tick();
}

function updateMeter(level) {
    const bar = document.getElementById("bar");
    if (!bar) return;

    const clamped = Math.max(0, Math.min(1, level));
    bar.style.width = `${clamped * 100}%`;
}

// =====================================
// ヘルプメモ（PC: ホバー追従ボックス / スマホ: 行追加トグル）
// =====================================
function setupHelpTooltips() {
    const tip = document.getElementById("help-tooltip");
    const bodyEl = tip?.querySelector(".help-tooltip-body");
    if (!tip || !bodyEl) return;

    const mobileQuery = window.matchMedia("(max-width: 480px)");
    let pcActive = null;
    let mobileOpenTrigger = null;

    const isMobile = () => mobileQuery.matches;

    const helpTextOf = (el) =>
        el.getAttribute("data-help") ||
        el.closest("[data-help]")?.getAttribute("data-help") ||
        "";

    const hidePcTip = () => {
        pcActive = null;
        tip.classList.remove("is-visible");
        tip.setAttribute("aria-hidden", "true");
    };

    const placePcTip = (clientX, clientY) => {
        const pad = 12;
        const offsetX = 14;
        const offsetY = 18;
        const rect = tip.getBoundingClientRect();
        let left = clientX + offsetX;
        let top = clientY + offsetY;

        if (left + rect.width > window.innerWidth - pad) {
            left = clientX - rect.width - offsetX;
        }
        if (top + rect.height > window.innerHeight - pad) {
            top = clientY - rect.height - offsetY;
        }
        tip.style.left = `${Math.max(pad, left)}px`;
        tip.style.top = `${Math.max(pad, top)}px`;
    };

    const showPcTip = (el, clientX, clientY) => {
        if (isMobile()) return;
        const text = helpTextOf(el);
        if (!text) return;
        bodyEl.textContent = text;
        tip.classList.add("is-visible");
        tip.setAttribute("aria-hidden", "false");
        pcActive = el;
        placePcTip(clientX, clientY);
    };

    const closeAllMobilePanels = () => {
        document.querySelectorAll(".help-panel.is-open").forEach((panel) => {
            panel.classList.remove("is-open");
            panel.setAttribute("aria-hidden", "true");
            panel.textContent = "";
        });
        mobileOpenTrigger = null;
    };

    const panelForTrigger = (trigger) => {
        const next = trigger.nextElementSibling;
        if (next && next.classList.contains("help-panel")) return next;
        return null;
    };

    // PC: mouse イベントで確実に表示
    document.querySelectorAll("[data-help]").forEach((el) => {
        el.addEventListener("mouseenter", (e) => {
            if (isMobile()) return;
            showPcTip(el, e.clientX, e.clientY);
        });
        el.addEventListener("mousemove", (e) => {
            if (isMobile() || pcActive !== el) return;
            placePcTip(e.clientX, e.clientY);
        });
        el.addEventListener("mouseleave", () => {
            if (isMobile()) return;
            if (pcActive === el) hidePcTip();
        });
    });

    // スマホ: 文字タップで直下に行を追加（レイアウトが押し下がる）
    document.querySelectorAll(".help-trigger").forEach((trigger) => {
        trigger.addEventListener("click", (e) => {
            if (!isMobile()) return;
            e.preventDefault();
            e.stopPropagation();

            const panel = panelForTrigger(trigger);
            const text = helpTextOf(trigger);
            if (!panel || !text) return;

            if (mobileOpenTrigger === trigger) {
                closeAllMobilePanels();
                return;
            }

            closeAllMobilePanels();
            panel.textContent = text;
            panel.classList.add("is-open");
            panel.setAttribute("aria-hidden", "false");
            mobileOpenTrigger = trigger;
        });
    });

    document.addEventListener("click", (e) => {
        if (!isMobile() || !mobileOpenTrigger) return;
        if (e.target.closest(".help-trigger") || e.target.closest(".help-panel")) return;
        closeAllMobilePanels();
    });

    mobileQuery.addEventListener("change", () => {
        hidePcTip();
        closeAllMobilePanels();
    });
}

// =====================================
// RNBO 接続前でも HTML 初期値で塗りを合わせる
syncAllHorizontalFills();
setupHelpTooltips();
setup();
