import { MaterialIcon } from "@/components/common/material-icon";

type NavLinkProps = {
  label: string;
  icon: string;
  active?: boolean;
  href?: string;
};

export function NavLink({ label, icon, active = false, href = "#" }: NavLinkProps) {
  if (active) {
    return (
      <a
        className="border-l-4 border-[#85adff] text-white bg-transparent px-6 py-4 flex items-center gap-3 font-headline tracking-wide font-bold uppercase"
        href={href}
      >
        <MaterialIcon name={icon} className="text-[#85adff]" />
        {label}
      </a>
    );
  }

  return (
    <a
      className="text-[#adaaaa] hover:text-white hover:bg-[#201f1f] transition-all duration-300 px-6 py-4 flex items-center gap-3 font-headline tracking-wide font-bold uppercase"
      href={href}
    >
      <MaterialIcon name={icon} />
      {label}
    </a>
  );
}
