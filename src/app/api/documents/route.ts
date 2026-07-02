import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return Response.json({ configured: false, documents: [] });
  }
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, mime_type, status, drive_modified_at, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ configured: true, documents: data });
}
