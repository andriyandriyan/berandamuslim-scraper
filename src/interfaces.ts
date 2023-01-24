export interface Post {
  id: number;
  date: string;
  modified: string;
  link: string;
  title: Title;
  _embedded?: Embedded;
}

export interface Embedded {
  'wp:featuredmedia': WpFeaturedmedia[];
  'wp:term': WpTerm[][];
}

export interface WpFeaturedmedia {
  id: number;
  date: string;
  slug: string;
  link: string;
  title: Title;
  caption: Title;
  alt_text: string;
  source_url: string;
}

export interface WpTerm {
  id: number;
  name: string;
  slug: string;
  taxonomy: 'category' | 'post_tag';
}

export interface Title {
  rendered: string;
}

export interface SholatScheduleResponse {
  status: boolean;
  data: SholatSchedule;
  message?: string;
}

export interface SholatSchedule {
  id: string;
  lokasi: string;
  daerah: string;
  koordinat: Coordinat;
  jadwal: Schedule;
}

export interface Coordinat {
  lat: number;
  lon: number;
  lintang: string;
  bujur: string;
}

export interface Schedule {
  tanggal: string;
  imsak: string;
  subuh: string;
  terbit: string;
  dhuha: string;
  dzuhur: string;
  ashar: string;
  maghrib: string;
  isya: string;
  date: string;
}

export interface YoutubeInitialData {
  contents: YoutubeInitialDataContent;
}

export interface YoutubeInitialDataContent {
  twoColumnBrowseResultsRenderer: TwoColumnBrowseResultsRenderer;
}

export interface TwoColumnBrowseResultsRenderer {
  tabs: Tab[];
}

export interface Tab {
  tabRenderer?: TabRenderer;
}

export interface TabRenderer {
  title: string;
  trackingParams: string;
  selected?: boolean;
  content?: TabRendererContent;
}

export interface TabRendererContent {
  richGridRenderer?: RichGridRenderer;
}

export interface RichGridRenderer {
  contents: RichGridRendererContent[];
}

export interface RichGridRendererContent {
  richItemRenderer?: RichItemRenderer;
}

export interface RichItemRenderer {
  content: RichItemRendererContent;
}

export interface RichItemRendererContent {
  videoRenderer: VideoRenderer;
}

export interface VideoRenderer {
  videoId: string;
}
