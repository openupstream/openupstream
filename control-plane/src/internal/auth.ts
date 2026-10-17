/**
 * Who is calling the internal API: the Kubernetes API server checks the
 * caller's ServiceAccount token with a TokenReview (ARCHITECTURE.md,
 * decision 53). No secret of our own to create or rotate.
 */
import { AuthenticationV1Api, type KubeConfig } from '@kubernetes/client-node';
import { type Result, err, ok } from '../result.js';

export interface Caller {
    /** e.g. `system:serviceaccount:openupstream-system:databases-operator` */
    readonly username: string;
}

export type AuthError =
    | { readonly kind: 'unauthenticated'; readonly reason: string }
    | { readonly kind: 'review-failed'; readonly message: string };

export type Authenticate = (token: string) => Promise<Result<Caller, AuthError>>;

/** What the TokenReview status says, reduced to the fields that decide. */
export interface ReviewStatus {
    readonly authenticated?: boolean;
    readonly audiences?: readonly string[];
    readonly username?: string;
    readonly error?: string;
}

/**
 * A token counts only if it was issued for `audience`. An empty audience
 * list means the token is valid for the API server itself, which every
 * ServiceAccount token in the cluster is: that must not be enough.
 */
export const callerFrom = (status: ReviewStatus, audience: string): Result<Caller, AuthError> => {
    if (status.authenticated !== true || status.username === undefined) {
        return err({ kind: 'unauthenticated', reason: status.error ?? 'token not authenticated' });
    }
    if (!(status.audiences ?? []).includes(audience)) {
        return err({ kind: 'unauthenticated', reason: `token not issued for ${audience}` });
    }
    return ok({ username: status.username });
};

export function tokenReviewAuthenticator(kubeConfig: KubeConfig, audience: string): Authenticate {
    const api = kubeConfig.makeApiClient(AuthenticationV1Api);
    return (token) =>
        api
            .createTokenReview({
                body: { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', spec: { token, audiences: [audience] } },
            })
            .then(
                (review) =>
                    callerFrom(
                        {
                            ...(review.status?.authenticated === undefined
                                ? {}
                                : { authenticated: review.status.authenticated }),
                            ...(review.status?.audiences === undefined ? {} : { audiences: review.status.audiences }),
                            ...(review.status?.user?.username === undefined
                                ? {}
                                : { username: review.status.user.username }),
                            ...(review.status?.error === undefined ? {} : { error: review.status.error }),
                        },
                        audience,
                    ),
                (error: unknown) =>
                    err({ kind: 'review-failed', message: error instanceof Error ? error.message : String(error) }),
            );
}
