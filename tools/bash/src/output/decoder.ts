import { StringDecoder } from "node:string_decoder";

export class Utf8Decoder {
  #decoder = new StringDecoder("utf8");
  #closed = false;

  write(chunk: Buffer): string {
    if (this.#closed) return "";
    return this.#decoder.write(chunk);
  }

  end(): string {
    if (this.#closed) return "";
    this.#closed = true;
    return this.#decoder.end();
  }
}

/** One independent streaming UTF-8 decoder per physical byte stream. */
export class Utf8DecoderBank<StreamId extends string> {
  #decoders = new Map<StreamId, Utf8Decoder>();
  #ended = new Set<StreamId>();

  write(stream: StreamId, chunk: Buffer): string {
    if (this.#ended.has(stream)) return "";
    let decoder = this.#decoders.get(stream);
    if (!decoder) {
      decoder = new Utf8Decoder();
      this.#decoders.set(stream, decoder);
    }
    return decoder.write(chunk);
  }

  end(stream: StreamId): string {
    if (this.#ended.has(stream)) return "";
    this.#ended.add(stream);
    const decoder = this.#decoders.get(stream);
    return decoder?.end() ?? "";
  }

  hasEnded(stream: StreamId): boolean {
    return this.#ended.has(stream);
  }
}
