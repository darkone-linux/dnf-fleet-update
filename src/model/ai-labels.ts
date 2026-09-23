// Shared AI feed labels: text stays plain; the interface owns their colour.

export const AI_LABEL = "AI";
export const YOU_LABEL = "YOU";

export const aiLabel = (message: string): string => `${AI_LABEL} ${message}`;
export const youLabel = (message: string): string => `${YOU_LABEL}: ${message}`;
