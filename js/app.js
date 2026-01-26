// app.js
// =====================================
// RNBO Web Audio Device Setup
// =====================================

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

    // Resume on click
    document.body.onclick = () => context.resume();

    startMeterLoop(analyser, meterBuffer);

    // 呼び出し順
    connectCustomSliders(device);  // RNBO param <-> Slider
    generateAllTicks();            // 各スライダーに ticks を DOM 生成
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

    for (let i = 0; i < count; i++) {
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
function connectCustomSliders(device) {

    // ★ ここが RNBO 側と合わせ込むパラメータ仕様 ★
    //   → RNBO パッチ内も同様に 0〜… の範囲になっている前提
    const specs = {
        // volume は 0〜10（UI上も 0〜10）
        volume:         { min: 0, max: 10, invert: false, step: 0.1 },

        // sensitivity: 0〜12（13段階）・逆転項目
        sensitivity:    { min: 0, max: 12, invert: true,  step: 1 },

        // dynamics: 0〜4（5段階）
        dynamics:       { min: 0, max: 4,  invert: false, step: 1 },

        // responsiveness: 0〜10（11段階）・逆転項目
        responsiveness: { min: 0, max: 10, invert: true,  step: 1 },

        // release: 0〜10
        release:        { min: 0, max: 10, invert: false, step: 1 }
    };

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
        if (!slider || !p) return;

        const spec = specs[param];
        if (!spec) return;

        // HTML の min/max/step も RNBO と合わせる
        slider.min = spec.min;
        slider.max = spec.max;
        if (spec.step > 0) {
            slider.step = spec.step;
        } else {
            slider.removeAttribute("step");
        }

        // Param → Slider
        const paramToSlider = (v) => {
            let val = v;
            if (spec.invert) {
                // 逆転：0 <-> max
                val = spec.max - v;
            }
            return val;
        };

        // Slider → Param
        const sliderToParam = (v) => {
            let raw = v;
            if (spec.invert) {
                raw = spec.max - v;
            }

            if (spec.step > 0) {
                raw = Math.round(raw / spec.step) * spec.step;
            }

            // 安全クリップ
            if (raw < spec.min) raw = spec.min;
            if (raw > spec.max) raw = spec.max;

            return raw;
        };

        // 初期値反映：RNBO の値を UI に
        slider.value = paramToSlider(p.value);

        // UI → RNBO
        slider.addEventListener("input", (e) => {
            const v = parseFloat(e.target.value);
            const paramValue = sliderToParam(v);
            if (p.value !== paramValue) {
                p.value = paramValue;
            }
        });

        // RNBO → UI（外部から param が変わったときも追従）
        device.parameterChangeEvent.subscribe(ev => {
            if (ev.id !== p.id) return;
            slider.value = paramToSlider(ev.value);
        });
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
        updateMeter(normalized);
        requestAnimationFrame(tick);
    };

    tick();
}

function updateMeter(level) {
    const bar = document.getElementById("bar");
    if (!bar) return;

    const clamped = Math.max(0, Math.min(1, level));
    bar.style.height = `${clamped * 100}%`;
}



// =====================================
setup();
