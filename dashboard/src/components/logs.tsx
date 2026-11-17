'use client';

import type { ApiResult, LogEntry, LogQuery, OpenUpstreamClient } from '@openupstream/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { appended, lineTime, podLabel, severalPods } from '../lib/logs';
import { api, refused } from '../lib/session';

/** Opens a log stream: a Service's, or a run's. */
export type LogSource = (client: OpenUpstreamClient, query: LogQuery, signal: AbortSignal) => Promise<ApiResult<AsyncIterable<LogEntry>>>;

/** How often the lines that arrived are put on the page: a busy container writes more often than is worth drawing. */
const DRAW_MS = 250;

/**
 * - `following`: the stream is open, new lines appear
 * - `ended`: the API ended it (every pod is gone, or an hour has passed)
 * - `paused`: the tab was hidden; it starts over when it is looked at again
 * - a string: what the API refused, or why the stream broke
 */
type State = 'following' | 'ended' | 'paused' | string;

/**
 * The last lines of a log and then the new ones as they are written (a
 * live tail, decision 130), for as long as this is shown and the tab is
 * looked at. Nothing is kept by the platform (decision 21): what a pod
 * wrote before it was replaced is gone.
 */
export function LogView({ source }: { readonly source: LogSource }) {
    const [lines, setLines] = useState<readonly LogEntry[]>([]);
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
        async (signal: AbortSignal): Promise<string | undefined> => {
            const opened = await latest.current(await api(), { follow: true }, signal);
            if (!opened.ok) {
                return signal.aborted ? undefined : refused(opened.error);
            }
            let waiting: LogEntry[] = [];
            const draw = () => {
                if (waiting.length > 0) {
                    const more = waiting;
                    waiting = [];
                    atEnd.current = box.current === null || box.current.scrollHeight - box.current.scrollTop - box.current.clientHeight < 8;
                    setLines((before) => appended(before, more));
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
        const start = () => {
            setLines([]);
            setState('following');
            void follow(controller.signal).then((problem) => {
                if (!controller.signal.aborted) {
                    setState(problem ?? 'ended');
                }
            });
        };
        if (document.visibilityState !== 'visible') {
            setState('paused');
            return undefined;
        }
        start();
        return () => controller.abort();
    }, [follow, again]);

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
                    ? state === 'following'
                        ? 'Nothing written yet.'
                        : 'Nothing was written.'
                    : lines.map((line, index) => (
                          <span key={index} className={line.previous ? 'previous' : undefined}>
                              <time>{lineTime(line.time)}</time> {withPod && <b>{podLabel(line.pod)} </b>}
                              {line.line}
                              {'\n'}
                          </span>
                      ))}
            </pre>
            <small role={state === 'following' || state === 'ended' || state === 'paused' ? undefined : 'alert'}>
                {state === 'following'
                    ? 'Following: new lines appear as they are written.'
                    : state === 'paused'
                      ? 'Paused while the tab was hidden.'
                      : state === 'ended'
                        ? 'The stream has ended: nothing runs any more, or an hour has passed.'
                        : state}{' '}
                {state !== 'following' && state !== 'paused' && (
                    <button type="button" className="link" onClick={() => setAgain(again + 1)}>
                        Follow again
                    </button>
                )}
            </small>
        </div>
    );
}

/** A log behind a "Logs" line that opens it: the stream is open only while it is. */
export function Logs({ source }: { readonly source: LogSource }) {
    const [open, setOpen] = useState(false);
    return (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>Logs</summary>
            {open && <LogView source={source} />}
        </details>
    );
}
