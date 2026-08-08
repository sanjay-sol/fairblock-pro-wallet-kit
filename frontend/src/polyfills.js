// Loaded FIRST (before the SDK) so browser globals the SDK may reference exist.
import { Buffer } from "buffer";
globalThis.Buffer = globalThis.Buffer || Buffer;
globalThis.global = globalThis.global || globalThis;
