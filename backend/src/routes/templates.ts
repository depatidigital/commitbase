import { Router, Response } from 'express';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { DeploymentService } from '../services/deployment';

const router = Router();
const deploymentService = new DeploymentService();

// Get all available templates
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const templates = await deploymentService.getAvailableTemplates();
    
    res.json({
      success: true,
      data: {
        templates,
        count: templates.length,
      },
      message: 'Templates retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get template content
router.get('/:templateName', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { templateName } = req.params;
    
    if (!templateName) {
      return res.status(400).json({
        success: false,
        error: 'Template name is required',
      } as ApiResponse);
    }

    const content = await deploymentService.getTemplateContent(templateName);
    
    return res.json({
      success: true,
      data: {
        templateName,
        content,
      },
      message: 'Template content retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching template content:', error);
    return res.status(404).json({
      success: false,
      error: error instanceof Error ? error.message : 'Template not found',
    } as ApiResponse);
  }
});

// Create new template
router.post('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { templateName, content } = req.body;
    
    if (!templateName || !content) {
      return res.status(400).json({
        success: false,
        error: 'Template name and content are required',
      } as ApiResponse);
    }

    // Validate template name (alphanumeric and hyphens only)
    if (!/^[a-zA-Z0-9-]+$/.test(templateName)) {
      return res.status(400).json({
        success: false,
        error: 'Template name can only contain letters, numbers, and hyphens',
      } as ApiResponse);
    }

    await deploymentService.createTemplate(templateName, content);
    
    return res.json({
      success: true,
      data: {
        templateName,
      },
      message: 'Template created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error creating template:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create template',
    } as ApiResponse);
  }
});

// Update template content
router.put('/:templateName', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { templateName } = req.params;
    const { content } = req.body;
    
    if (!templateName || !content) {
      return res.status(400).json({
        success: false,
        error: 'Template name and content are required',
      } as ApiResponse);
    }

    await deploymentService.updateTemplateContent(templateName, content);
    
    return res.json({
      success: true,
      data: {
        templateName,
      },
      message: 'Template updated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error updating template:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update template',
    } as ApiResponse);
  }
});

// Delete template
router.delete('/:templateName', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { templateName } = req.params;
    
    if (!templateName) {
      return res.status(400).json({
        success: false,
        error: 'Template name is required',
      } as ApiResponse);
    }

    await deploymentService.deleteTemplate(templateName);
    
    return res.json({
      success: true,
      data: {
        templateName,
      },
      message: 'Template deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting template:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete template',
    } as ApiResponse);
  }
});

// Preview template with sample data
router.post('/:templateName/preview', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { templateName } = req.params;
    const sampleData = req.body;
    
    if (!templateName) {
      return res.status(400).json({
        success: false,
        error: 'Template name is required',
      } as ApiResponse);
    }

    const content = await deploymentService.getTemplateContent(templateName);
    
    // Simple template rendering for preview
    let previewContent = content;
    Object.entries(sampleData).forEach(([key, value]) => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      previewContent = previewContent.replace(regex, String(value));
    });
    
    return res.json({
      success: true,
      data: {
        templateName,
        originalContent: content,
        previewContent,
        sampleData,
      },
      message: 'Template preview generated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error generating template preview:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate template preview',
    } as ApiResponse);
  }
});

export default router; 
