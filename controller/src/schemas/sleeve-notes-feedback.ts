import { z } from 'zod';

export const sparkFeedbackSchema = z.object({
  story: z.union([z.enum(['good', 'routine', 'unclear', 'incorrect', 'wrong-subject']), z.literal('').transform(() => null)]).nullable(),
  delivery: z.union([z.enum(['worked', 'forced', 'wrong-subject']), z.literal('').transform(() => null)]).nullable(),
  note: z.string().trim().max(500),
}).refine(value => value.story !== null || value.delivery !== null, {
  message: 'Choose story or delivery feedback', path: ['story'],
}).refine(value => !['unclear', 'incorrect', 'wrong-subject'].includes(value.story ?? '') || value.note.length >= 20, {
  message: 'Describe the specific problem in at least 20 characters for Review', path: ['note'],
});

export const sleeveNotesReviewSchema = z.object({
  category: z.string().refine(value => ['artist-stories', 'release-stories', 'track-stories', 'musical-connections', 'milestones', 'credits', 'recognition'].includes(value), 'Choose a supported category'),
  topic: z.string().trim().min(2, 'Topic must be 2–100 characters').max(100, 'Topic must be 2–100 characters'),
  wording: z.string().trim().min(8, 'Full story must be a complete sentence under 360 characters')
    .max(360, 'Full story must be a complete sentence under 360 characters')
    .regex(/[.!?][”"']?$/u, 'Full story must be a complete sentence under 360 characters'),
  shortWording: z.string(),
  evidence: z.string().trim().min(24, 'Supporting passage must be an exact excerpt from the saved source (24–900 characters)')
    .max(900, 'Supporting passage must be an exact excerpt from the saved source (24–900 characters)'),
});

export const airingReviewResultSchema = z.object({
  finding: z.enum(['presentation', 'spark', 'timing', 'unsuitable', 'unclear', 'no-issue']),
  summary: z.string().trim().min(1).max(600),
  explanation: z.string().trim().min(1).max(2400),
  suggestedSpeech: z.string().trim().max(3000),
  proposedGuidance: z.string().trim().min(1).max(600).nullable(),
  sparkCorrection: z.object({ claimId: z.string().min(1), wording: z.string().trim().min(8).max(360),
    evidence: z.string().trim().min(24).max(900) }).nullable(),
});
export const airingReviewDecisionSchema = z.object({
  action: z.enum(['resolve', 'dismiss', 'apply-guidance', 'apply-correction', 'revoke-guidance', 'retry', 'restore-fact', 'delete-fact', 'withdraw-fact']),
  correction: sleeveNotesReviewSchema.pick({wording:true,evidence:true}).extend({claimId:z.string().min(1)}).optional(),
}).refine(value=>!value.correction||value.action==='apply-correction', {
  message:'Edited corrections can only be supplied when applying a correction',path:['correction'],
});
