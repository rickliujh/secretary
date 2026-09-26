import { ulid } from "ulidx";

export const newId = (): string => ulid();

export const nowIso = (): string => new Date().toISOString();
