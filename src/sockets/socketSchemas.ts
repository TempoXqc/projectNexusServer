import { z } from 'zod';
import { CardSchema } from "@tempoxqc/project-nexus-types";

export const PlayCardSchema = z.object({
  gameId: z.string(),
  card: CardSchema,
  fieldIndex: z.number().min(0).max(7),
});

export const JoinGameSchema = z.object({
  gameId: z.string(),
  username: z.string().optional(),
});
