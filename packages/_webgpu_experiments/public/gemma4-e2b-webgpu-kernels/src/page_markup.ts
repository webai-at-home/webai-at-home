///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PageMarkup — builds the markup of the page, in the shape the Transformers.js experiment uses
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// The shape of this page follows packages/_onnx_experiments/public/qwen3_5-2b/, so that the two experiments
// read the same way. The two extra panels below the results are the ones this package's rules ask for and that
// page does not have: the correctness check, and a measurement over several runs.

export class PageMarkup {
	/**
	 * Builds the markup of the whole page.
	 *
	 * @param modelId The Hugging Face model the page loads, shown beside the prompt.
	 * @param defaultPrompt The question the prompt box holds when the page opens.
	 * @param warmupRunCount How many runs the measurement throws away, named in the hint beside its button.
	 * @param measuredRunCount How many runs the measurement measures, named in the hint beside its button.
	 * @returns The markup, ready to be written into the `#app` element.
	 */
	static build(modelId: string, defaultPrompt: string, warmupRunCount: number, measuredRunCount: number): string {
		return `
  <main class="shell experiment-shell">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
      <span id="runtime-pill" class="runtime-pill"><i></i><span id="runtime-label">Checking runtime</span></span>
    </header>
    <section class="hero">
      <p class="eyebrow">Browser inference / field test 01 / issue #207</p>
      <h1>Gemma 4 E2B<br /><em>WebGPU compute kernels</em></h1>
      <p class="intro">Gemma 4 E2B on WebGPU compute kernels this page holds itself. No ONNX Runtime Web, no
      Transformers.js, and no LiteRT.js between the page and the graphics processor. The weights start
      downloading as soon as the page opens.</p>
    </section>
    <section class="test-panel" aria-labelledby="test-heading">
      <div class="panel-heading">
        <div><p class="section-label">Test prompt</p><h2 id="test-heading">A small question, a useful answer.</h2></div>
        <span class="model-tag">${modelId}</span>
      </div>
      <label class="sr-only" for="prompt">Prompt</label>
      <textarea id="prompt" rows="3">${defaultPrompt}</textarea>
      <div class="controls">
        <button id="run-button" class="primary-button" type="button">Loading model… <span class="spinner"></span></button>
        <span class="hint">Streaming · greedy · stops at the end token</span>
      </div>
    </section>
    <section class="results" aria-live="polite">
      <div class="result-copy">
        <p class="section-label">Output</p>
        <p id="output" class="output-text placeholder">Run the experiment to see the model's answer.</p>
      </div>
      <div class="metrics">
        <div class="metric"><span>Model load</span><strong id="load-time">—</strong></div>
        <div class="metric"><span>Generation</span><strong id="generation-time">—</strong></div>
        <div class="metric"><span>Output rate</span><strong id="speed">—</strong></div>
        <div class="metric"><span>Backend</span><strong id="backend">—</strong></div>
      </div>
    </section>
    <section class="gate-panel">
      <div class="gate-heading">
        <div>
          <p class="section-label">Correctness</p>
          <h2>Right answers before fast answers.</h2>
        </div>
        <button id="check-button" class="secondary-button" type="button" disabled>Run the correctness check</button>
      </div>
      <p class="hint">WebGPU returns wrong numbers silently, so a generation that runs to the end proves nothing.
      The measurement below stays locked until every check here passes.</p>
      <ul id="check-results" class="check-list"></ul>
      <div class="comparison">
        <div>
          <p class="section-label">This page · WebGPU compute kernels</p>
          <p id="webgpu-kernels-answer" class="answer placeholder">—</p>
        </div>
        <div>
          <p class="section-label">_onnx_experiments · Transformers.js</p>
          <p id="transformers-js-answer" class="answer placeholder">—</p>
        </div>
      </div>
    </section>
    <section class="gate-panel">
      <div class="gate-heading">
        <div>
          <p class="section-label">Measurement</p>
          <h2>${measuredRunCount} runs, not one.</h2>
        </div>
        <button id="measure-button" class="secondary-button" type="button" disabled>Run the measurement</button>
      </div>
      <p class="hint">${warmupRunCount} warm-up runs thrown away, ${measuredRunCount} runs measured, middle
      figure first and the range after it. Keep this page in sight while it runs.</p>
      <div class="metrics wide-metrics">
        <div class="metric"><span>Time to first token</span><strong id="time-to-first-token">—</strong></div>
        <div class="metric"><span>Tokens per second</span><strong id="tokens-per-second">—</strong></div>
        <div class="metric"><span>Answer length</span><strong id="token-count">—</strong></div>
        <div class="metric"><span>Runs</span><strong id="run-count">—</strong></div>
      </div>
      <p id="page-visibility" class="warning"></p>
    </section>
    <p id="status" class="status">Ready.</p>
    <footer>
      <span>Hand-written WebGPU compute kernels</span>
      <span>Local inference · no prompt upload</span>
    </footer>
  </main>
`;
	}
}
