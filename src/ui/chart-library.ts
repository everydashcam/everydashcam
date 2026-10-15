import { Chart, Decimation, LineController, LineElement, LinearScale, PointElement } from "chart.js";

// Keep the timeline's components explicit so unused chart types and built-in
// legend, tooltip and fill plugins stay out of the deferred viewer bundle.
Chart.register(LineController, LineElement, PointElement, LinearScale, Decimation);

export { Chart };
