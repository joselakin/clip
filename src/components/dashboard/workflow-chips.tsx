const workflows = [
  "YouTube Podcast to Shorts",
  "Gaming Highlight Reel",
  "Educational Summary",
];

export function WorkflowChips() {
  return (
    <div className="mt-16 flex flex-wrap justify-center gap-3 opacity-60 hover:opacity-100 transition-opacity">
      <span className="text-xs font-bold uppercase tracking-widest text-[#adaaaa] w-full text-center mb-2">
        Popular Workflows
      </span>
      {workflows.map((workflow) => (
        <button
          key={workflow}
          type="button"
          className="px-4 py-2 rounded-lg bg-surface-container-low border border-white/5 text-sm text-[#adaaaa] hover:text-white hover:bg-surface-container-high transition-all"
        >
          {workflow}
        </button>
      ))}
    </div>
  );
}
