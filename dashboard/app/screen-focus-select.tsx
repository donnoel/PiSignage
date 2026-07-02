"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

type ScreenFocusOption = {
  location: string;
  screenId: string;
  screenName: string;
};

type ScreenFocusSelectProps = {
  options: ScreenFocusOption[];
  selectedScreenId: string;
};

export function ScreenFocusSelect({ options, selectedScreenId }: ScreenFocusSelectProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <label htmlFor="screen-focus" className="sr-only">Choose screen to preview</label>
      <select
        id="screen-focus"
        value={selectedScreenId}
        disabled={isPending || options.length === 0}
        onChange={(event) => {
          const screenId = event.currentTarget.value;
          startTransition(() => {
            router.push(`/?view=dashboard&screen=${encodeURIComponent(screenId)}`);
            router.refresh();
          });
        }}
        className="min-h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:cursor-not-allowed disabled:bg-zinc-100"
      >
        {options.length === 0 ? (
          <option value="">No screens in inventory</option>
        ) : (
          options.map((option) => (
            <option key={option.screenId} value={option.screenId}>
              {option.screenName} · {option.location}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
