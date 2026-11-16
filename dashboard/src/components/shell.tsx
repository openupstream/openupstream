'use client';

import type { MadauthUser } from '@madauth/web';
import type { ReactNode } from 'react';
import { manageApiKeys, signIn, signOut, useUser } from '../lib/session';

/** The header and the sign-in: `children` is what a signed-in Member sees. */
export function Shell({ children }: { readonly children: (user: MadauthUser) => ReactNode }) {
    const { user, problem } = useUser();
    return (
        <>
            <header>
                <a className="brand" href="/">
                    openupstream
                </a>
                {user != null && (
                    <nav>
                        <span>{user.email ?? user.name ?? user.id}</span>
                        <button type="button" className="link" onClick={() => void manageApiKeys()}>
                            API keys
                        </button>
                        <button type="button" className="link" onClick={() => void signOut()}>
                            Sign out
                        </button>
                    </nav>
                )}
            </header>
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
