/**
 * Where the API is (ARCHITECTURE.md, decision 67): what the build was given
 * (`NEXT_PUBLIC_API_URL`, for development), otherwise `api.` in front of the
 * dashboard's own hostname, so one build serves every installation.
 */
export const apiUrlFor = (page: { readonly protocol: string; readonly host: string }, configured: string | undefined): string =>
    configured !== undefined && configured !== '' ? configured.replace(/\/+$/, '') : `${page.protocol}//api.${page.host}`;
