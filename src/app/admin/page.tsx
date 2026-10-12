"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** The old "Corpus" address; the page is now called Documents. */
export default function OldCorpusPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/documents/");
  }, [router]);
  return null;
}
