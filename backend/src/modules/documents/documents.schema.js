import { UUID_PATTERN } from '../../utils/validation.js';
import { courseParams } from '../courses/courses.schema.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const documentListSchema = {
  querystring: {
    ...courseParams,
    properties: {
      ...courseParams.properties,
      page: { type: 'integer', minimum: 1, maximum: Math.floor(Number.MAX_SAFE_INTEGER / MAX_PAGE_SIZE), default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    },
  },
};
export const documentIdSchema = {
  params: {
    type: 'object',
    required: ['documentId'],
    properties: { documentId: { type: 'string', pattern: UUID_PATTERN } },
  },
};
export const documentUpdateSchema = {
  ...documentIdSchema,
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH, pattern: '\\S' },
      description: { type: ['string', 'null'], maxLength: MAX_DESCRIPTION_LENGTH },
    },
  },
};
