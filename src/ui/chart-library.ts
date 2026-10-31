import { Chart, LineController, LineElement, LinearScale, PointElement } from "chart.js";

// Keep the timeline's components explicit so unused chart types and built-in
// legend, tooltip and fill plugins stay out of the deferred viewer bundle.
// Decimation is the gap-aware plugin in chart-decimation.ts, not Chart.js's own.
Chart.register(LineController, LineElement, PointElement, LinearScale);

export { Chart };
