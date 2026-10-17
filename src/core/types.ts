// 核心数据类型。本目录（src/core）不依赖 DOM 和浏览器存储，
// 可以原样移植到微信小程序或其他运行环境。

export type Category =
  | 'top'
  | 'bottom'
  | 'dress'
  | 'outer'
  | 'shoes'
  | 'bag'
  | 'hat'
  | 'scarf'
  | 'belt'
  | 'jewelry';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Occasion = 'commute' | 'formal' | 'casual' | 'sport' | 'date' | 'travel';
export type Style =
  | 'minimal'
  | 'casual'
  | 'business'
  | 'sporty'
  | 'street'
  | 'vintage'
  | 'sweet'
  | 'outdoor';

/** 版型：修身 / 常规 / 宽松 */
export type Fit = 'slim' | 'regular' | 'loose';
/** 长度：短款 / 常规 / 长款（不同类别含义见 catalog.LENGTH_LABELS） */
export type Length = 'short' | 'regular' | 'long';
/** 腰线：高 / 中 / 低（下装为裤腰位置，连衣裙为腰线位置） */
export type Rise = 'high' | 'mid' | 'low';
export type Pattern = 'solid' | 'stripe' | 'check' | 'print' | 'colorblock';
/** 保暖度：1 轻薄 / 2 适中 / 3 厚实 */
export type Warmth = 1 | 2 | 3;
/** active 在用；archived 已归档；pending 批量录入后待整理（确认前不参与推荐） */
export type ItemStatus = 'active' | 'archived' | 'pending';

export interface ColorInfo {
  hex: string;
  name: string;
}

export interface ImageRefs {
  /** 透明背景的换装贴图（已裁切到衣物边界） */
  cutout: string;
  /** 衣橱网格使用的缩略图 */
  thumb: string;
  /** 原图（缩放后），用于档案 */
  original?: string;
  /** 背面的透明贴图（可选）。拍摄时把衣服左右翻过来平铺，图片就是从身后看的样子 */
  backCutout?: string;
  backThumb?: string;
  backOriginal?: string;
}

export interface Item {
  id: string;
  name: string;
  category: Category;
  subtype: string;
  color: ColorInfo;
  color2?: ColorInfo;
  pattern: Pattern;
  seasons: Season[];
  warmth: Warmth;
  occasions: Occasion[];
  styles: Style[];
  fit?: Fit;
  length?: Length;
  rise?: Rise;
  /** 材质或面料成分，例如"棉 95%，氨纶 5%"；吊牌识别时按规范格式填写 */
  material?: string;
  brand?: string;
  /** 货号 / 款号 */
  styleNo?: string;
  /** 尺码或号型原文，例如 M、W30、175/92A */
  size?: string;
  /** 吊牌识别记录：保留原文，以后解析规则改进时可以重新解析 */
  tagInfo?: TagRecord;
  tags: string[];
  favorite: boolean;
  status: ItemStatus;
  images: ImageRefs;
  /** 换装贴图宽高比 w / h */
  imageAspect: number;
  /** 外套能不能敞开穿（拉链、纽扣）；不填时按子类判断 */
  openable?: boolean;
  /** 照片里已经是敞开的（拍的时候没拉拉链），人台上总是敞开显示 */
  photoOpen?: boolean;
  /** 连帽上衣：贴图最上面这一段（占图片高度的比例）是摊开的帽子，试穿时放下（人台上藏起来、按肩线对齐） */
  hoodTop?: number;
  /** 试穿时不放下帽子（帽子认错了，例如高领、立领） */
  hoodUp?: boolean;
  /** 量出的基准宽度（衣身 / 上身 / 腰头），人台上按身材定大小用；见 core/measure.ts */
  shape?: { w: number; cx: number; top: number; bottom?: number };
  /** 录入页里调过的大小（1 为默认） */
  sizeAdjust?: number;
  /** 背面贴图宽高比（有背面照片时） */
  backAspect?: number;
  createdAt: number;
  updatedAt: number;
  /** 示例数据标记，方便一键清除 */
  demo?: boolean;
  /** 待整理时的提示，例如"衣服和背景颜色接近，去背可能不准"；确认后去掉 */
  reviewNote?: string;
}

export interface TagRecord {
  /** 识别或粘贴得到的吊牌文字 */
  raw: string;
  source: 'ocr' | 'paste';
  /** 执行标准，例如 GB/T 22849-2014 */
  standard?: string;
  /** 吊牌上标注的版型（剪裁本身），用于和身材对比时作为基准 */
  fit?: Fit;
  updatedAt: number;
}

export type Gender = 'female' | 'male' | 'unspecified';

export interface BodyProfile {
  /** 身高 cm */
  height: number;
  /** 肩宽 cm（两肩峰之间的直线距离） */
  shoulder: number;
  /** 胸围 cm */
  chest: number;
  /** 腰围 cm */
  waist: number;
  /** 臀围 cm */
  hip: number;
  /** 内侧腿长 cm（裆部到地面） */
  inseam: number;
  /** 仅用于校准身材比例的参考阈值 */
  gender: Gender;
  /** 体重 kg（用于在没填三围时估算体型） */
  weight?: number;
  /** 哪些尺寸是按身高体重估算的（没有亲自测量） */
  estimated?: MeasureKey[];
}

/** 可以由身高体重估算的尺寸 */
export type MeasureKey = 'shoulder' | 'chest' | 'waist' | 'hip' | 'inseam';

export type BodyGoal = 'lengthen_legs' | 'balance_upper' | 'balance_lower' | 'define_waist';

/** 人台上单件衣物的手动微调，单位为 cm（以人台坐标计） */
export interface Placement {
  dx: number;
  dy: number;
  scale: number;
}

/** 穿法：哪件上衣塞进下装、哪件外套敞开穿（单品 id） */
export interface Styling {
  tucked?: string[];
  open?: string[];
}

export interface Outfit {
  id: string;
  name: string;
  itemIds: string[];
  layout: Record<string, Placement>;
  styling?: Styling;
  occasions: Occasion[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  demo?: boolean;
}

export interface ItemSnapshot {
  id: string;
  name: string;
  category: Category;
  colorHex: string;
}

export type RecordSource = 'recommend' | 'builder' | 'manual';

export interface WearRecord {
  id: string;
  /** YYYY-MM-DD，本地日期 */
  date: string;
  itemIds: string[];
  /** 单品被删除后仍能显示名称和颜色 */
  itemSnapshots: ItemSnapshot[];
  outfitId?: string;
  layout?: Record<string, Placement>;
  styling?: Styling;
  occasion?: Occasion;
  tempC?: number;
  note?: string;
  /** 真实上身照片的图片 id */
  photo?: string;
  source: RecordSource;
  createdAt: number;
  updatedAt: number;
  demo?: boolean;
}

export type GarmentLook = 'flat' | 'photo';

export interface SavedLocation {
  lat: number;
  lon: number;
  label?: string;
}

export interface Settings {
  body: BodyProfile | null;
  goals: BodyGoal[];
  /** 用户是否手动改过搭配目标；未改过时随身材数据自动更新 */
  goalsCustomized: boolean;
  location?: SavedLocation;
  /** 推荐时是否优先轮换闲置单品 */
  rotation: boolean;
  /** 人台上的衣服显示为：简化图形（去掉褶皱，默认）或照片 */
  garmentLook?: GarmentLook;
}

export interface FeedbackState {
  /** 单品两两组合的偏好分，key 为排序后的 "idA|idB" */
  pairs: Record<string, number>;
  /** 明确不喜欢的整套组合签名 */
  dislikedOutfits: string[];
}

export interface WeatherInput {
  /** 代表气温（白天体感），°C */
  tempC: number;
  tempMin?: number;
  tempMax?: number;
  rain: boolean;
}

export type NoteKind = 'good' | 'warn' | 'info';

export interface Note {
  kind: NoteKind;
  text: string;
}
