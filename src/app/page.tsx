"use client";

import AuthGate from "@/components/AuthGate";
import Chat from "@/components/Chat";

export default function Page() {
  return <AuthGate>{(session) => <Chat session={session} />}</AuthGate>;
}
