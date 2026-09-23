import { z } from "zod";
import { WidgetSchema, type NewWidget, type Widget } from "./schemas.js";

// Deliberate compile error: a string is not assignable to a number (TS2322).
const broken: number = "this client does not compile";

export class ApiClient {
  constructor() {}
}
