CREATE TYPE public.app_role AS ENUM ('admin', 'reviewer', 'leadership', 'requester');
CREATE TYPE public.request_status AS ENUM ('submitted', 'under_review', 'approved', 'rejected', 'completed');
CREATE TYPE public.funding_source AS ENUM ('department', 'research', 'university');
CREATE TYPE public.request_priority AS ENUM ('low', 'medium', 'high');

CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  department TEXT,
  title TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.user_roles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE public.financial_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE DEFAULT ('FR-' || to_char(now(), 'YYYY') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))),
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  department TEXT NOT NULL,
  funding_source public.funding_source NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  needed_by DATE NOT NULL,
  priority public.request_priority NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  grant_number TEXT,
  principal_investigator TEXT,
  university_program TEXT,
  status public.request_status NOT NULL DEFAULT 'submitted',
  workflow_triggered_at TIMESTAMPTZ,
  routed_to TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.request_attachments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  actor_user_id UUID,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_reviewer(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'admin') OR public.has_role(_user_id, 'reviewer') OR public.has_role(_user_id, 'leadership');
$$;

CREATE TRIGGER update_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_financial_requests_updated_at
BEFORE UPDATE ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Users can view their own profile"
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() = user_id OR public.is_admin_or_reviewer(auth.uid()));

CREATE POLICY "Users can create their own profile"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
ON public.profiles FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own role records"
ON public.user_roles FOR SELECT TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage role records"
ON public.user_roles FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Requesters can view their own requests"
ON public.financial_requests FOR SELECT TO authenticated
USING (auth.uid() = user_id OR public.is_admin_or_reviewer(auth.uid()));

CREATE POLICY "Requesters can create their own requests"
ON public.financial_requests FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Requesters can edit own submitted requests"
ON public.financial_requests FOR UPDATE TO authenticated
USING ((auth.uid() = user_id AND status = 'submitted') OR public.is_admin_or_reviewer(auth.uid()))
WITH CHECK ((auth.uid() = user_id AND status = 'submitted') OR public.is_admin_or_reviewer(auth.uid()));

CREATE POLICY "Users can view permitted attachments"
ON public.request_attachments FOR SELECT TO authenticated
USING (auth.uid() = user_id OR public.is_admin_or_reviewer(auth.uid()));

CREATE POLICY "Users can add attachments to own requests"
ON public.request_attachments FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove own attachments"
ON public.request_attachments FOR DELETE TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view workflow events for permitted requests"
ON public.workflow_events FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.financial_requests fr
    WHERE fr.id = workflow_events.request_id
      AND (fr.user_id = auth.uid() OR public.is_admin_or_reviewer(auth.uid()))
  )
);

CREATE POLICY "Users can create workflow events for own requests"
ON public.workflow_events FOR INSERT TO authenticated
WITH CHECK (
  actor_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.financial_requests fr
    WHERE fr.id = workflow_events.request_id
      AND fr.user_id = auth.uid()
  )
);

CREATE POLICY "Reviewers can create workflow events"
ON public.workflow_events FOR INSERT TO authenticated
WITH CHECK (public.is_admin_or_reviewer(auth.uid()));

INSERT INTO storage.buckets (id, name, public)
VALUES ('request-attachments', 'request-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can view permitted request files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'request-attachments'
  AND (auth.uid()::text = (storage.foldername(name))[1] OR public.is_admin_or_reviewer(auth.uid()))
);

CREATE POLICY "Users can upload own request files"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'request-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can update own request files"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'request-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'request-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete own request files"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'request-attachments'
  AND (auth.uid()::text = (storage.foldername(name))[1] OR public.has_role(auth.uid(), 'admin'))
);

CREATE INDEX idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX idx_user_roles_user_role ON public.user_roles(user_id, role);
CREATE INDEX idx_financial_requests_user_status ON public.financial_requests(user_id, status);
CREATE INDEX idx_financial_requests_created_at ON public.financial_requests(created_at DESC);
CREATE INDEX idx_request_attachments_request_id ON public.request_attachments(request_id);
CREATE INDEX idx_workflow_events_request_id ON public.workflow_events(request_id, created_at DESC);