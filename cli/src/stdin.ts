/**
 * Secret values come from stdin, never from arguments, which shells keep in
 * their history and the system shows in its process list (decision 94).
 * Piped input is read to its end; at a terminal, the value is asked for
 * without echoing it.
 */

/** One trailing line break goes, as `echo` adds it; everything else is the value. */
export const trimLineBreak = (text: string): string => text.replace(/\r?\n$/, '');

async function readPiped(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return trimLineBreak(Buffer.concat(chunks).toString('utf8'));
}

/** Reads keys in raw mode until Enter: nothing is echoed; Backspace deletes, Ctrl-C and Ctrl-D give up. */
function promptHidden(prompt: string): Promise<string | undefined> {
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    return new Promise((resolve) => {
        let value = '';
        const done = (result: string | undefined) => {
            process.stdin.off('data', onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stderr.write('\n');
            resolve(result);
        };
        const onData = (keys: string) => {
            for (const key of keys) {
                if (key === '\r' || key === '\n') {
                    return done(value);
                }
                if (key === '\u0003' || key === '\u0004') {
                    return done(undefined);
                }
                value = key === '\u007f' || key === '\b' ? value.slice(0, -1) : value + key;
            }
        };
        process.stdin.on('data', onData);
    });
}

/** The value from stdin; undefined when the person at the terminal gave up. */
export const readSecretValue = (prompt: string): Promise<string | undefined> =>
    process.stdin.isTTY ? promptHidden(prompt) : readPiped();
