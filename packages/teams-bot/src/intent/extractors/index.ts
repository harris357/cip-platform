// Slice 55: extractor registry.
//
// Single source of truth for which tools have a deterministic
// extractor. Used by the grammar router to look up an extractor by
// tool name, and by `make extractor-coverage` to flag tools that
// don't yet have one.
//
// Adding a new extractor: add the file under extractors/, export it
// here, and confirm a grammar pattern points to its toolName.

import type { Extractor } from './types.js';
import { employeeDisableExtractor }       from './employee-disable.js';
import { employeeFindExtractor }          from './employee-find.js';
import { employeeListExtractor }          from './employee-list.js';
import { getMyCertificationsExtractor }   from './get-my-certifications.js';
import { getStaffCertificationsExtractor } from './get-staff-certifications.js';

export const EXTRACTORS: Record<string, Extractor> = {
  employee_disable:        employeeDisableExtractor,
  employee_find:           employeeFindExtractor,
  employee_list:           employeeListExtractor,
  get_my_certifications:   getMyCertificationsExtractor,
  get_staff_certifications: getStaffCertificationsExtractor,
};

export type { Extractor, ExtractionResult, DisambiguationCandidate } from './types.js';
