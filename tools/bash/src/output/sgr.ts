function sgrNumber(value: string | undefined): number {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function colonColorValues(parts: string[], inheritedColor: number | undefined): number[] | undefined {
  const color = inheritedColor ?? sgrNumber(parts[0]);
  if (color !== 38 && color !== 48) return undefined;
  const modeIndex = inheritedColor === undefined ? 1 : 0;
  const mode = sgrNumber(parts[modeIndex]);
  const values = inheritedColor === undefined ? [color] : [];

  if (mode === 5 && parts.length > modeIndex + 1) {
    return [...values, 5, sgrNumber(parts[modeIndex + 1])];
  }
  if (mode !== 2) return undefined;

  let components = parts.slice(modeIndex + 1);
  // ISO-8613 colon form may include an empty or explicit colorspace ID before
  // RGB. Three remaining subparameters are the common no-colorspace form.
  if (components.length >= 4) components = components.slice(1);
  if (components.length < 3) return undefined;
  return [...values, 2, ...components.slice(0, 3).map(sgrNumber)];
}

/**
 * Parses SGR parameters into the conventional flat form used by the projector.
 * Colon subparameters stay within their owning attribute: color spaces are
 * normalized to RGB/indexed values and variants such as `4:3` remain one
 * underline attribute rather than accidentally enabling another style.
 */
export function parseSgrParameters(body: string): number[] {
  if (body === "") return [0];
  const values: number[] = [];
  for (const segment of body.split(";")) {
    if (!segment.includes(":")) {
      values.push(sgrNumber(segment));
      continue;
    }

    const parts = segment.split(":");
    const previous = values.at(-1);
    const inheritedColor = (previous === 38 || previous === 48) ? previous : undefined;
    const color = colonColorValues(parts, inheritedColor);
    if (color) {
      values.push(...color);
      continue;
    }

    // Unsupported subparameter variants retain their primary SGR attribute.
    values.push(sgrNumber(parts[0]));
  }
  return values;
}
