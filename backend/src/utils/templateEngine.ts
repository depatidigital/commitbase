import * as fs from 'fs/promises';
import * as path from 'path';

export interface TemplateData {
  [key: string]: any;
}

export class TemplateEngine {
  private templatesDir: string;

  constructor() {
    this.templatesDir = path.join(process.cwd(), 'src', 'templates', 'dockerfiles');
  }

  /**
   * Render a template with data
   */
  async renderTemplate(templateName: string, data: TemplateData, templateType: 'dockerfile' | 'compose' = 'dockerfile'): Promise<string> {
    try {
      const extension = templateType === 'compose' ? 'yml' : 'Dockerfile';
      
      // For compose templates, look in the main templates directory
      // For dockerfile templates, look in the dockerfiles subdirectory
      const baseDir = templateType === 'compose' 
        ? path.join(process.cwd(), 'src', 'templates')
        : this.templatesDir;
      
      const templatePath = path.join(baseDir, `${templateName}.${extension}`);
      let template = await fs.readFile(templatePath, 'utf-8');

      // Simple template engine with Handlebars-like syntax
      template = this.replaceConditionals(template, data);
      template = this.replaceVariables(template, data);

      return template;
    } catch (error) {
      throw new Error(`Failed to render template ${templateName}: ${error}`);
    }
  }

  /**
   * Replace conditional blocks {{#if variable}}...{{/if}}
   */
  private replaceConditionals(template: string, data: TemplateData): string {
    const conditionalRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
    
    return template.replace(conditionalRegex, (match, variable, content) => {
      if (data[variable] && data[variable] !== '' && data[variable] !== 'false') {
        return content;
      }
      return '';
    });
  }

  /**
   * Replace variables {{variable}}
   */
  private replaceVariables(template: string, data: TemplateData): string {
    const variableRegex = /\{\{(\w+)\}\}/g;
    
    return template.replace(variableRegex, (match, variable) => {
      return data[variable] || '';
    });
  }

  /**
   * Get available template names
   */
  async getAvailableTemplates(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.templatesDir);
      return files
        .filter(file => file.endsWith('.Dockerfile'))
        .map(file => file.replace('.Dockerfile', ''));
    } catch (error) {
      console.error('Failed to read templates directory:', error);
      return [];
    }
  }

  /**
   * Get available compose template names
   */
  async getAvailableComposeTemplates(): Promise<string[]> {
    try {
      const mainTemplatesDir = path.join(process.cwd(), 'src', 'templates');
      const files = await fs.readdir(mainTemplatesDir);
      return files
        .filter(file => file.endsWith('.yml'))
        .map(file => file.replace('.yml', ''));
    } catch (error) {
      console.error('Failed to read compose templates directory:', error);
      return [];
    }
  }

  /**
   * Validate template data
   */
  validateTemplateData(templateName: string, data: TemplateData): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Common required fields
    if (!data.port) {
      errors.push('Port is required');
    }

    if (!data.startCommand) {
      errors.push('Start command is required');
    }

    // Template-specific validation
    switch (templateName) {
      case 'nodejs':
        if (!data.buildCommand && !data.startCommand) {
          errors.push('Either build command or start command is required for Node.js');
        }
        break;
      
      case 'python':
        if (!data.startCommand) {
          errors.push('Start command is required for Python');
        }
        break;
      
      case 'go':
        // Go doesn't need additional validation
        break;
      
      case 'rust':
        // Rust doesn't need additional validation
        break;
      
      case 'php':
        // PHP doesn't need additional validation
        break;
      
      case 'java':
        // Java doesn't need additional validation
        break;
      
      case 'static':
        // Static doesn't need additional validation
        break;
      
      default:
        errors.push(`Unknown template type: ${templateName}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
} 