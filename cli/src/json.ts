/** JSON.parse only throws; this answers undefined for text that is no JSON. */
export const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};
