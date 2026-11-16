import {
  BellOff, BookOpen, Bot, Briefcase, Cat, CircleDollarSign, Crown, Drama, Dumbbell, Flower2, Folder, Folders,
  Gamepad2, GraduationCap, Heart, House, Lightbulb, Mail, Megaphone, Notebook, Palette, PartyPopper, Plane,
  Settings, Star, ThumbsUp, TrendingUp, User, Users, type LucideIcon,
} from "lucide-react";
import type { FolderIcon } from "../core/contract.ts";

const icons: Record<FolderIcon, LucideIcon> = {
  All: Folders, Unread: Mail, Unmuted: BellOff, Bots: Bot, Channels: Megaphone, Groups: Users, Private: User,
  Custom: Folder, Setup: Settings, Cat, Crown, Favorite: Star, Flower: Flower2, Game: Gamepad2, Home: House,
  Love: Heart, Mask: Drama, Party: PartyPopper, Sport: Dumbbell, Study: GraduationCap, Trade: TrendingUp,
  Travel: Plane, Work: Briefcase, Airplane: Plane, Book: BookOpen, Light: Lightbulb, Like: ThumbsUp,
  Money: CircleDollarSign, Note: Notebook, Palette,
};

export function FolderGlyph({ icon, color }: { icon?: FolderIcon; color?: string }) {
  const Glyph = icon ? icons[icon] : Folder;
  return <Glyph size={17} aria-hidden="true" color={color} />;
}
