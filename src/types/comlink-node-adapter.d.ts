// Comlink ships the Node adapter as .mjs with a .d.ts rather than .d.mts.
declare module "comlink/dist/esm/node-adapter.mjs" {
    export { default } from "comlink/dist/esm/node-adapter";
}
