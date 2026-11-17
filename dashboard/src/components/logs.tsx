'use client';

import type { ApiResult, LogEntry, LogQuery, OpenUpstreamClient } from '@openupstream/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { appended, lineTime, podLabel, severalPods } from '../lib/logs';
import { api, refused } from '../lib/session';

/** Opens a log stream: a Service's, or a run's. */
export type LogSource = (client: OpenUpstreamClient, query: LogQuery, signal: AbortSignal) => Promise<ApiResult<AsyncIterable<LogEntry>>>;

/** How long a log that waits for something to run leaves between two tries. */
const WAIT_MS = 5_000;

/** How often the lines that arrived are put on the page: a busy container writes more often than is worth drawing. */
const DRAW_MS = 250;

/**
 * - `following`: the stream is open, new lines appear
 * - `ended`: the API ended it (every pod is gone, or an hour has passed)
 * - `waiting`: the same for a log that `waits`; it follows again by itself
 * - `paused`: the tab is hidden; it follows again when it is looked at
 * - a string: what the API refused, or why the stream broke
 */
type State = 'following' | 'ended' | 'waiting' | 'paused' | string;

/**
 * The last lines of a log and then the new ones as they are written (a
 * live tail, decision 130), for as long as this is shown and the tab is
 * looked at. Nothing is kept by the platform (decision 21): what a pod
 * wrote before it was replaced is gone.
 *
 * With `waits`, the end of the stream is not the end of the log: a Service
 * is always on, so when nothing runs (it is being deployed) or an hour has
 * passed, the log follows again by itself. A run's log ends with the run.
 */
export function LogView({ source, waits = false }: { readonly source: LogSource; readonly waits?: boolean }) {
    // The lines shown, and how many older ones were dropped: together a line's number, which stays its own.
    const [{ lines, dropped }, setLog] = useState<{ readonly lines: readonly LogEntry[]; readonly dropped: number }>({ lines: [], dropped: 0 });
    // Whether lines are shown: following again then adds to them and reads only what is written from then on.
    const shown = useRef(false);
    const [resumed, setResumed] = useState(false);
    const [state, setState] = useState<State>('following');
    // Counts the times it was asked to follow again.
    const [again, setAgain] = useState(0);
    const box = useRef<HTMLPreElement>(null);
    // Whether the reader is at the end, read before new lines are drawn: only then the view moves with them.
    const atEnd = useRef(true);
    // The newest `source`: a parent that draws again passes a new function for the same log, which must not start the stream over.
    const latest = useRef(source);
    latest.current = source;

    const follow = useCallback(
        async (signal: AbortSignal, query: LogQuery): Promise<string | undefined> => {
            const opened = await latest.current(await api(), query, signal);
            if (!opened.ok) {
                return signal.aborted ? undefined : refused(opened.error);
            }
            let waiting: LogEntry[] = [];
            const draw = () => {
                if (waiting.length > 0) {
                    const more = waiting;
                    waiting = [];
                    atEnd.current = box.current === null || box.current.scrollHeight - box.current.scrollTop - box.current.clientHeight < 8;
                    shown.current = true;
                    setLog((before) => {
                        const next = appended(before.lines, more);
                        return { lines: next, dropped: before.dropped + before.lines.length + more.length - next.length };
                    });
                }
            };
            const timer = window.setInterval(draw, DRAW_MS);
            // Reading a stream fails when the connection breaks or the reader stops it: that is its end, not an exception to pass on.
            const broke = await (async () => {
                for await (const entry of opened.value) {
                    waiting.push(entry);
                }
                return undefined;
            })().catch((error: unknown) => (signal.aborted ? undefined : `The log stream broke: ${error instanceof Error ? error.message : String(error)}`));
            window.clearInterval(timer);
            draw();
            return broke;
        },
        [],
    );

    useEffect(() => {
        const controller = new AbortController();
        let retry: number | undefined;
        const start = () => {
            // What is shown stays: nothing is kept anywhere else. Only what is written from now on is added to it.
            setResumed(shown.current);
            setState('following');
            void follow(controller.signal, shown.current ? { follow: true, tail: 0 } : { follow: true }).then((problem) => {
                if (controller.signal.aborted) {
                    return;
                }
                setState(problem ?? (waits ? 'waiting' : 'ended'));
                if (problem === undefined && waits) {
                    retry = window.setTimeout(() => setAgain((count) => count + 1), WAIT_MS);
                }
            });
        };
        if (document.visibilityState !== 'visible') {
            setState('paused');
            return undefined;
        }
        start();
        return () => {
            controller.abort();
            window.clearTimeout(retry);
        };
    }, [follow, again, waits]);

    // A hidden tab holds no stream: there are only so many per Account.
    useEffect(() => {
        const onChange = () => setAgain((count) => count + 1);
        document.addEventListener('visibilitychange', onChange);
        return () => document.removeEventListener('visibilitychange', onChange);
    }, []);

    useEffect(() => {
        if (atEnd.current && box.current !== null) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [lines]);

    const withPod = severalPods(lines);
    return (
        <div className="logs">
            <pre ref={box} tabIndex={0}>
                {lines.length === 0
                    ? state === 'following' || state === 'waiting'
                        ? 'Nothing written yet.'
                        : 'Nothing was written.'
                    : lines.map((line, index) => (
                          <span key={dropped + index} className={line.previous ? 'previous' : undefined}>
                              <time>{lineTime(line.time)}</time> {withPod && <b>{podLabel(line.pod)} </b>}
                              {line.line}
                              {'\n'}
                          </span>
                      ))}
            </pre>
            <small role={state === 'following' || state === 'ended' || state === 'waiting' || state === 'paused' ? undefined : 'alert'}>
                {state === 'following'
                    ? `Following: new lines appear as they are written.${resumed ? ' What was written while it was not following is not shown.' : ''}`
                    : state === 'paused'
                      ? 'Paused while the tab is hidden.'
                      : state === 'waiting'
                        ? 'Nothing runs right now. Following again as soon as something does.'
                        : state === 'ended'
                          ? 'The stream has ended: nothing runs any more, or an hour has passed.'
                          : state}{' '}
                {state !== 'following' && state !== 'paused' && state !== 'waiting' && (
                    <button type="button" className="link" onClick={() => setAgain(again + 1)}>
                        Follow again
                    </button>
                )}
            </small>
        </div>
    );
}

/** A log behind a "Logs" line that opens it: the stream is open only while it is. */
export function Logs({ source, waits = false }: { readonly source: LogSource; readonly waits?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>Logs</summary>
            {open && <LogView source={source} waits={waits} />}
        </details>
    );
}
