// Type-only imports: the shared Zod contracts are the single source of truth
// for API shapes. These imports are erased at build time (no runtime code).
import type {
  CurrentRideSchema,
  OtpRequestResponseSchema,
  PricingSummarySchema,
  RideSchema,
  RiderProfileSchema,
  ScooterLookupSchema,
  RiderScooterSchema,
  SessionResponseSchema,
  TopUpSchema,
  WalletSchema,
  WalletTransactionSchema,
} from '@captain/contracts';
import type { z } from 'zod';

export type Ride = z.infer<typeof RideSchema>;
export type RideStatus = Ride['status'];
export type CurrentRide = z.infer<typeof CurrentRideSchema>;
export type Pricing = z.infer<typeof PricingSummarySchema>;
export type Wallet = z.infer<typeof WalletSchema>;
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;
export type TopUp = z.infer<typeof TopUpSchema>;
export type NearbyScooter = z.infer<typeof RiderScooterSchema>;
export type ScooterLookup = z.infer<typeof ScooterLookupSchema>;
export type Session = z.infer<typeof SessionResponseSchema>;
export type OtpChallenge = z.infer<typeof OtpRequestResponseSchema>;
export type RiderProfile = z.infer<typeof RiderProfileSchema>;
