'use client';

import type { MadauthUser } from '@madauth/web';
import type { ReactNode } from 'react';
import { isAdmin } from '../lib/nodes';
import { type User, manageApiKeys, signIn, signOut, useUser } from '../lib/session';

function Header({ user }: { readonly user: User }) {
    return (
        <header>
            <a className="brand" href="/">
                openupstream
            </a>
            <nav>
                <a href="/cli">CLI</a>
                {user != null && isAdmin(user.claims) && <a href="/nodes">Sites &amp; nodes</a>}
                {user != null && (
                    <>
                        <span>{user.email ?? user.name ?? user.id}</span>
                        <button type="button" className="link" onClick={() => void manageApiKeys()}>
                            API keys
                        </button>
                        <button type="button" className="link" onClick={() => void signOut()}>
                            Sign out
                        </button>
                    </>
                )}
            </nav>
        </header>
    );
}

/** The header and the sign-in: `children` is what a signed-in Member sees. */
export function Shell({ children }: { readonly children: (user: MadauthUser) => ReactNode }) {
    const { user, problem } = useUser();
    return (
        <>
            <Header user={user} />
            <main>
                {problem !== undefined ? (
                    <p role="alert">{problem}</p>
                ) : user === undefined ? (
                    <p aria-busy="true">Loading…</p>
                ) : user === null ? (
                    <section className="welcome">
                        <h1>Open source cloud infrastructure, hosted in the EU</h1>
                        <p>Sign in, or create your account, to set up Projects with Postgres, object storage, static sites and containers.</p>
                        <button type="button" onClick={() => void signIn()}>
                            Sign in or sign up
                        </button>
                    </section>
                ) : (
                    children(user)
                )}
            </main>
        </>
    );
}

/** The header around a page anyone may read, signed in or not. */
export function OpenShell({ children }: { readonly children: ReactNode }) {
    const { user } = useUser();
    return (
        <>
            <Header user={user} />
            <main>{children}</main>
        </>
    );
}
