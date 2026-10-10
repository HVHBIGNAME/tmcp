import { StringDecoder } from 'node:string_decoder';

export function secretRedactor(values: string[]): (text: string) => string {
  const secrets = [...new Set(values.filter((value) => value.length >= 4))].sort(
    (left, right) => right.length - left.length,
  );
  return (text) => {
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text;
  };
}

/** Retains only a suffix that could be the start of a secret split across chunks. */
export function redactedStream(values: string[], emit: (text: string) => void) {
  const secrets = [...new Set(values.filter((value) => value.length >= 4))];
  const redact = secretRedactor(secrets);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    write(chunk: Buffer) {
      pending = redact(pending + decoder.write(chunk));
      let retained = 0;
      for (const secret of secrets) {
        const start = Math.max(0, pending.length - secret.length + 1);
        for (
          let index = pending.indexOf(secret[0]!, start);
          index !== -1;
          index = pending.indexOf(secret[0]!, index + 1)
        ) {
          if (secret.startsWith(pending.slice(index))) {
            retained = Math.max(retained, pending.length - index);
            break;
          }
        }
      }
      const boundary = pending.length - retained;
      if (boundary) emit(pending.slice(0, boundary));
      pending = pending.slice(boundary);
    },
    end() {
      const final = decoder.end();
      if (pending) emit('[redacted]');
      if (final) emit(redact(final));
      pending = '';
    },
  };
}
