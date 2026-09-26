/** Validate the JSON Schema subset used by this application's AI contracts.
 * No dynamic code generation (Workers disallow eval); unsupported keywords fail
 * closed when a provider cannot enforce the schema itself.
 */
type Schema = Record<string, unknown>;
const supported = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "anyOf", "oneOf", "allOf", "const", "minimum", "maximum", "minItems", "maxItems",
  "minLength", "maxLength", "description", "title", "$schema", "default",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function matchesAiSchema(value: unknown, schema: unknown, depth = 0): boolean {
  if (schema === true) return true;
  if (schema === false || !object(schema) || depth > 64) return false;
  if (Object.keys(schema).some(key => !supported.has(key))) return false;
  const match = (v: unknown, s: unknown) => matchesAiSchema(v, s, depth + 1);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => match(value, s))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(s => match(value, s)).length !== 1) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every(s => match(value, s))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) return false;
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return object(value);
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return (type === "string" || type === "boolean") && typeof value === type;
  })) return false;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every(item => match(item, schema.items))) return false;
  }
  if (object(value)) {
    const properties = object(schema.properties) ? schema.properties as Record<string, Schema> : {};
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) { if (!match(item, properties[key])) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (object(schema.additionalProperties) && !match(item, schema.additionalProperties)) return false;
    }
  }
  return true;
}
