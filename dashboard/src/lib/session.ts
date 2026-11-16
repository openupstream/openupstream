'use client';

import type { MadauthUser } from '@madauth/web';
import { type ApiError, OpenUpstreamClient } from '@openupstream/sdk';
import { useEffect, useState } from 'react';

/** madAuth's client. It defines web components, so it only loads in the browser. */
const madauth = () => import('@madauth/web');

/** `undefined` until madAuth has answered, `null` when nobody is signed in. */
export type User = MadauthUser | null | undefined;

/**
 * Sets up madAuth, once per page however often components mount. A page
 * opened from `oup login` (`?madauth_device=<code>`) shows the approval
 * dialog, which asks for a sign-in first when needed (ARCHITECTURE.md,
 * decision 87). Resolves to what is wrong, or undefined.
 */
let initialized: Promise<string | undefined> | undefined;
const initialize = (): Promise<string | undefined> =>
    (initialized ??= madauth()
        .then(async ({ Madauth, Password }) => {
            const result = await Madauth.initialize({ providers: [new Password()] });
            if (!result.isSuccess) {
                return `Sign-in is not available now: ${result.error.message}`;
            }
            const url = new URL(window.location.href);
            const code = url.searchParams.get('madauth_device');
            if (code !== null) {
                // The code works once: out of the address, so a reload does not ask again.
                url.searchParams.delete('madauth_device');
                window.history.replaceState(null, '', url);
                void Madauth.showDeviceApprovalDialog({ code });
            }
            return undefined;
        })
        // The import itself failed, e.g. the network went away.
        .catch(() => 'Sign-in could not be loaded. Reload the page.')
        .then((problem) => {
            // A failure is not kept: the next page that mounts tries again.
            initialized = problem === undefined ? initialized : undefined;
            return problem;
        }));

/** Who is signed in, followed across sign-ins and sign-outs. */
export function useUser(): { readonly user: User; readonly problem: string | undefined } {
    const [user, setUser] = useState<User>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    useEffect(() => {
        // A listener of this effect's own: madAuth keeps listeners by identity, so
        // an earlier effect that unsubscribes `setUser` itself would take this one's too.
        const subscription = madauth().then(
            ({ Madauth }) => Madauth.onAuthStateChanged((next) => setUser(next)),
            () => () => undefined,
        );
        void initialize().then(setProblem);
        return () => void subscription.then((unsubscribe) => unsubscribe());
    }, []);
    return { user, problem };
}

/**
 * Asks madAuth whether the session still exists, after the API answered
 * 401: when it does not, the page goes back to the sign-in.
 */
export const sessionEnded = () => madauth().then(({ Madauth }) => Madauth.getSession());

export const signIn = () => madauth().then(({ Madauth }) => Madauth.showSignInDialog());
export const signOut = () => madauth().then(({ Madauth }) => Madauth.signOut());
export const manageApiKeys = () => madauth().then(({ Madauth }) => Madauth.showManageApiKeysDialog());

/** The API is under `/api` of the dashboard's own host (ARCHITECTURE.md, decision 120). */
const API_PATH = '/api';

/**
 * The API as the signed-in Member: the browser sends madAuth's session
 * cookie to its own origin. Waits for a session that expired to be renewed
 * first, so the API finds a valid one.
 */
export async function api(): Promise<OpenUpstreamClient> {
    const { Madauth } = await madauth();
    await Madauth.sessionReady();
    return new OpenUpstreamClient({ baseUrl: API_PATH, session: 'cookie' });
}

/**
 * What to show for a refusal of the API. A 401 also has madAuth look at the
 * session, which signs the page out when it is gone.
 */
export const refused = (error: ApiError): string => {
    if (error.status === 401) {
        void sessionEnded();
        return 'Your session has ended. Sign in again.';
    }
    return error.status === 0 ? `The API could not be reached: ${error.message}` : error.message;
};
