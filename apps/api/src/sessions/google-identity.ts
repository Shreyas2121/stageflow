export type GoogleProfile = { subject: string; name: string | null };
export type GoogleCodeExchange = (code: string, verifier: string) => Promise<GoogleProfile>;
