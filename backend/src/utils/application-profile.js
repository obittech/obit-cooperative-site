import { HttpError } from '../router.js';

export function validateApplicationProfile(profile) {
  const required = ['full_legal_name', 'date_of_birth', 'phone', 'email', 'address', 'state', 'lga', 'membership_type'];
  const missing = required.filter(key => typeof profile[key] !== 'string' || !profile[key].trim());
  if (missing.length) throw new HttpError(422, `Missing required fields: ${missing.join(', ')}`);
  if (profile.full_legal_name.trim().split(/\s+/).length < 2) {
    throw new HttpError(422, 'Enter your full legal name as it appears on your ID.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new HttpError(422, 'Enter a valid email address.');
  if (!/^\+?[0-9]{10,15}$/.test(profile.phone.replace(/[\s()-]/g, ''))) throw new HttpError(422, 'Enter a valid phone number.');
  const dob = profile.date_of_birth;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(`${dob}T00:00:00Z`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dob
      || dob >= new Date().toISOString().slice(0, 10)) {
    throw new HttpError(422, 'Enter a valid date of birth in the past.');
  }
}
