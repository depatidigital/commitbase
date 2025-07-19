import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const validateRequest = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if the schema expects a full request object or just the body
      const sampleData = { body: req.body, query: req.query, params: req.params };
      
      try {
        // Try to validate as full request object first
        const validatedData = schema.parse(sampleData);
        req.body = validatedData.body;
        req.query = validatedData.query;
        req.params = validatedData.params;
      } catch (fullRequestError) {
        // If that fails, try to validate just the body
        const validatedBody = schema.parse(req.body);
        req.body = validatedBody;
      }
      
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: error.errors,
        });
      }
      
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  };
}; 