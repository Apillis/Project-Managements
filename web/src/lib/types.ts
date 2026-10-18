import type { ReactNode } from 'react';

export type Row = Record<string, any>;
export type Mode = 'read' | 'write';

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'money' | 'percent' | 'date' | 'datetime'
  | 'checkbox' | 'select' | 'ref' | 'tags' | 'email' | 'json';

export interface RefDef {
  /** table or view to search */
  table: string;
  /** columns shown as the option label (joined by " · ") */
  label: string[];
  /** columns searched with ilike (defaults to label) */
  search?: string[];
  /** static equality filters */
  where?: Record<string, string | number | boolean>;
  /** column IN (...) filters */
  whereIn?: Record<string, readonly string[]>;
  /** columns that must be > 0 */
  positive?: string[];
  /** dynamic filters from the row being edited (e.g. same project) */
  whereFrom?: (row: Row) => Record<string, string | number | boolean | null | undefined>;
  valueColumn?: string;
  orderBy?: string;
  /** extra columns returned to onPick (e.g. to copy uom) */
  extra?: string[];
}

export interface FieldDef {
  name: string;
  label: string;            // i18n key
  type: FieldType;
  required?: boolean;
  enumKey?: string;         // i18n namespace for options: e.<enumKey>.<value>
  options?: readonly string[];
  ref?: RefDef;
  default?: unknown | ((ctx: { projectId?: string }) => unknown);
  readOnly?: boolean;
  /** only editable when creating */
  createOnly?: boolean;
  hidden?: boolean;
  wide?: boolean;
  min?: number;
  max?: number;
  step?: number;
  help?: string;            // i18n key
  /** copy values from the picked ref row into the form */
  onPick?: (picked: Row, row: Row) => Row;
}

export interface ColumnDef {
  name: string;
  label: string;            // i18n key
  type?: FieldType | 'status' | 'bool' | 'progress' | 'code' | 'tree' | 'link';
  enumKey?: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  render?: (row: Row) => ReactNode;
  /** money columns: column holding the currency code */
  currencyColumn?: string;
}

export interface LinesDef {
  table: string;
  fk: string;
  view?: string;
  columns: ColumnDef[];
  fields: FieldDef[];
  orderBy?: string;
  /** compute footer totals for these numeric columns */
  totals?: string[];
}

export interface ResourceDef {
  key: string;
  table: string;
  view?: string;
  resource: string;         // permission resource
  title: string;            // i18n key (plural)
  titleOne: string;         // i18n key (singular)
  module: string;
  columns: ColumnDef[];
  fields: FieldDef[];
  searchColumns: string[];
  sort: { column: string; asc: boolean };
  projectColumn?: string;
  statusColumn?: string;
  statusEnum?: readonly string[];
  dateColumn?: string;
  docType?: string;         // approval engine doc type
  /** header fields that stay editable after submission (must match the DB guard whitelist) */
  openFields?: string[];
  /** statuses a user may set after approval (buttons) */
  nextStatuses?: Record<string, readonly string[]>;
  /** statuses in which header and lines are editable (default: draft, rejected) */
  editableStatuses?: readonly string[];
  /** statuses in which the record may be deleted (default: draft) */
  deleteStatuses?: readonly string[];
  lines?: LinesDef;
  /** label of a row for headings */
  rowLabel?: (row: Row) => string;
  /** insert-only ledgers */
  noUpdate?: boolean;
  noDelete?: boolean;
  exportKey?: string;
  /** detail route override */
  detailPath?: (row: Row) => string;
}

export interface Notification {
  id: number;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
}
