/** Version 1 wire types. JSON received over the network must also be validated at runtime. */
export type Role = 'admin' | 'owner' | 'agent' | 'reviewer';
export type Principal = { id: string; workspace: string; roles: Role[]; token: string; active: boolean };
export type TaskStatus = 'pending' | 'running' | 'review' | 'completed' | 'cancelled';
export type SubtaskStatus = 'invited' | 'accepted' | 'submitted' | 'verified' | 'outcome_unknown' | 'returned' | 'rejected' | 'timed_out' | 'cancelled';
export type Evidence = { source: string; observedAt: string; quantity?: number; summary?: string; reference?: string };
export type TaskInput = { title: string; material: string; quantity: number; due: string; acceptance: string };
