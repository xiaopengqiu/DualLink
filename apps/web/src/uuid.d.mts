export function captureId(crypto?: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>): string;
