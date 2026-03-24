-- Axiom Platform: RPC Functions

-- Atomically decrement AI credits for a user (floor at 0)
CREATE OR REPLACE FUNCTION public.decrement_credits(uid UUID, amount INT)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET ai_credits_remaining = GREATEST(ai_credits_remaining - amount, 0),
      updated_at = now()
  WHERE id = uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
