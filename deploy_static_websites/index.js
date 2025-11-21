#!/usr/bin/env node

import { config } from 'dotenv';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';

// Load environment variables from .env file
config();

class S3Uploader {
  constructor(bucketName, region = 'us-east-1', distributionId = null) {
    this.bucketName = bucketName;
    this.s3Client = new S3Client({ region });
    this.cloudFrontClient = new CloudFrontClient({ region });
    this.distributionId = distributionId;
    this.uploadedCount = 0;
    this.failedCount = 0;
  }

  /**
   * Check if a file is an HTML file
   */
  isHtmlFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.html' || ext === '.htm';
  }

  /**
   * Get appropriate Cache-Control header based on file type and folder context
   */
  getCacheControlHeader(filePath, isAstroFolder = false) {
    if (isAstroFolder) {
      return 'public, max-age=31536000, immutable';
    }
    if (this.isHtmlFile(filePath)) {
      return 'public, max-age=0, must-revalidate';
    }
    return 'public, max-age=31536000, immutable';
  }

  /**
   * Upload a single file to S3
   */
  async uploadFile(filePath, s3Key, isAstroFolder = false) {
    try {
      const fileContent = fs.readFileSync(filePath);
      const contentType = mime.lookup(filePath) || 'application/octet-stream';
      const cacheControl = this.getCacheControlHeader(filePath, isAstroFolder);

      const commandParams = {
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: contentType,
        CacheControl: cacheControl,
      };

      // Add Access-Control-Allow-Origin header for non-HTML files
      if (!this.isHtmlFile(filePath)) {
        commandParams.Metadata = {
          'access-control-allow-origin': '*'
        };
        // Also set it as a custom header that CloudFront can use
        commandParams.Metadata['x-amz-meta-access-control-allow-origin'] = '*';
      }

      const command = new PutObjectCommand(commandParams);

      await this.s3Client.send(command);
      const corsInfo = !this.isHtmlFile(filePath) ? ', CORS: *' : '';
      console.log(`✅ Uploaded: ${s3Key} (${contentType}, ${cacheControl}${corsInfo})`);
      this.uploadedCount++;
      return true;
    } catch (error) {
      console.error(`❌ Failed to upload ${s3Key}:`, error.message);
      this.failedCount++;
      return false;
    }
  }

  /**
   * Delete all objects with a given prefix from S3
   */
  async deleteObjectsWithPrefix(prefix) {
    try {
      console.log(`🗑️  Deleting objects with prefix: ${prefix}`);
      
      let continuationToken;
      let deletedCount = 0;
      
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        
        const listResponse = await this.s3Client.send(listCommand);
        
        if (listResponse.Contents && listResponse.Contents.length > 0) {
          const deletePromises = listResponse.Contents.map(obj => {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.bucketName,
              Key: obj.Key,
            });
            return this.s3Client.send(deleteCommand);
          });
          
          await Promise.all(deletePromises);
          deletedCount += listResponse.Contents.length;
          console.log(`🗑️  Deleted ${listResponse.Contents.length} objects`);
        }
        
        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);
      
      console.log(`🗑️  Total deleted objects: ${deletedCount}`);
      return deletedCount;
    } catch (error) {
      console.error(`❌ Failed to delete objects with prefix ${prefix}:`, error.message);
      throw error;
    }
  }

  /**
   * Recursively traverse directory and upload files
   */
  async uploadDirectory(localPath, s3Prefix = '', isAstroFolder = false) {
    const stats = fs.statSync(localPath);
    
    if (stats.isFile()) {
      const s3Key = s3Prefix ? `${s3Prefix}/${path.basename(localPath)}` : path.basename(localPath);
      await this.uploadFile(localPath, s3Key, isAstroFolder);
      return;
    }

    if (stats.isDirectory()) {
      const items = fs.readdirSync(localPath);
      
      for (const item of items) {
        const itemPath = path.join(localPath, item);
        const newS3Prefix = s3Prefix ? `${s3Prefix}/${item}` : item;
        const itemIsAstroFolder = isAstroFolder || item === '_astro';
        
        if (fs.statSync(itemPath).isDirectory()) {
          await this.uploadDirectory(itemPath, newS3Prefix, itemIsAstroFolder);
        } else {
          await this.uploadFile(itemPath, newS3Prefix, itemIsAstroFolder);
        }
      }
    }
  }

  /**
   * Main upload method for dist folder with _astro and category subfolders
   */
  async uploadDist(distPath, s3Path) {
    console.log(`🚀 Starting upload from: ${distPath}`);
    console.log(`📦 Target bucket: ${this.bucketName}`);
    console.log(`🎯 S3 path: ${s3Path}`);
    console.log('');

    if (!fs.existsSync(distPath)) {
      throw new Error(`Dist folder does not exist: ${distPath}`);
    }

    const astroPath = path.join(distPath, '_astro');
    const categoryPath = path.join(distPath, 'category');

    // Check if _astro and category folders exist
    const astroExists = fs.existsSync(astroPath);
    const categoryExists = fs.existsSync(categoryPath);

    if (!astroExists && !categoryExists) {
      throw new Error(`Neither _astro nor category folder found in: ${distPath}`);
    }

    const startTime = Date.now();

    // Get all items in dist folder
    const distItems = fs.readdirSync(distPath);
    
    // Separate files and folders
    const rootFiles = [];
    const rootFolders = [];
    
    for (const item of distItems) {
      const itemPath = path.join(distPath, item);
      const stats = fs.statSync(itemPath);
      
      if (stats.isFile()) {
        rootFiles.push(item);
      } else if (stats.isDirectory() && item !== '_astro' && item !== 'category') {
        rootFolders.push(item);
      }
    }

    // Delete existing folders on S3
    if (astroExists) {
      console.log('🗑️  Deleting existing _astro folder from S3...');
      const astroS3Prefix = s3Path.endsWith('/') ? `${s3Path}_astro/` : `${s3Path}/_astro/`;
      await this.deleteObjectsWithPrefix(astroS3Prefix);
    }

    if (categoryExists) {
      console.log('🗑️  Deleting existing category folder from S3...');
      const categoryS3Prefix = s3Path.endsWith('/') ? `${s3Path}category/` : `${s3Path}/category/`;
      await this.deleteObjectsWithPrefix(categoryS3Prefix);
    }

    // Delete existing root files and other folders on S3
    if (rootFiles.length > 0 || rootFolders.length > 0) {
      console.log('🗑️  Deleting existing root files and folders from S3...');
      const baseS3Prefix = s3Path.endsWith('/') ? s3Path : `${s3Path}/`;
      
      // Delete root files
      for (const file of rootFiles) {
        const fileS3Key = `${baseS3Prefix}${file}`;
        try {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: fileS3Key,
          }));
        } catch (error) {
          // Ignore errors for files that don't exist
        }
      }
      
      // Delete other root folders
      for (const folder of rootFolders) {
        const folderS3Prefix = `${baseS3Prefix}${folder}/`;
        await this.deleteObjectsWithPrefix(folderS3Prefix);
      }
    }

    console.log('');

    // Upload root files
    if (rootFiles.length > 0) {
      console.log('📤 Uploading root files...');
      const baseS3Prefix = s3Path.endsWith('/') ? s3Path : `${s3Path}/`;
      for (const file of rootFiles) {
        const filePath = path.join(distPath, file);
        const fileS3Key = `${baseS3Prefix}${file}`;
        await this.uploadFile(filePath, fileS3Key, false);
      }
    }

    // Upload other root folders
    if (rootFolders.length > 0) {
      console.log('📤 Uploading other root folders...');
      const baseS3Prefix = s3Path.endsWith('/') ? s3Path : `${s3Path}/`;
      for (const folder of rootFolders) {
        const folderPath = path.join(distPath, folder);
        const folderS3Prefix = `${baseS3Prefix}${folder}`;
        await this.uploadDirectory(folderPath, folderS3Prefix, false);
      }
    }

    // Upload new folders
    if (astroExists) {
      console.log('📤 Uploading _astro folder with cache control...');
      const astroS3Prefix = s3Path.endsWith('/') ? `${s3Path}_astro` : `${s3Path}/_astro`;
      await this.uploadDirectory(astroPath, astroS3Prefix, true);
    }

    if (categoryExists) {
      console.log('📤 Uploading category folder as-is...');
      const categoryS3Prefix = s3Path.endsWith('/') ? `${s3Path}category` : `${s3Path}/category`;
      await this.uploadDirectory(categoryPath, categoryS3Prefix, false);
    }

    const endTime = Date.now();

    console.log('');
    console.log('📊 Upload Summary:');
    console.log(`✅ Successfully uploaded: ${this.uploadedCount} files`);
    console.log(`❌ Failed uploads: ${this.failedCount} files`);
    console.log(`⏱️  Total time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
  }

  /**
   * Legacy upload method for backward compatibility
   */
  async upload(folderPath) {
    console.log(`🚀 Starting upload from: ${folderPath}`);
    console.log(`📦 Target bucket: ${this.bucketName}`);
    console.log('');

    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder does not exist: ${folderPath}`);
    }

    const startTime = Date.now();
    await this.uploadDirectory(folderPath);
    const endTime = Date.now();

    console.log('');
    console.log('📊 Upload Summary:');
    console.log(`✅ Successfully uploaded: ${this.uploadedCount} files`);
    console.log(`❌ Failed uploads: ${this.failedCount} files`);
    console.log(`⏱️  Total time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
  }

  /**
   * Monitor CloudFront invalidation progress
   */
  async monitorInvalidationProgress(invalidationId) {
    try {
      console.log(`🔍 Monitoring invalidation progress: ${invalidationId}`);
      
      const pollInterval = 10000; // Poll every 10 seconds
      const maxPollingTime = 300000; // Stop polling after 5 minutes
      let polledTime = 0;
      
      while (polledTime < maxPollingTime) {
        const command = new GetInvalidationCommand({
          DistributionId: this.distributionId,
          Id: invalidationId
        });
        
        const result = await this.cloudFrontClient.send(command);
        const status = result.Invalidation.Status;
        const createTime = result.Invalidation.CreateTime;
        const paths = result.Invalidation.InvalidationBatch.Paths.Items;
        
        console.log(`📊 Status: ${status} | Created: ${createTime} | Paths: ${paths.join(', ')}`);
        
        if (status === 'Completed') {
          console.log(`✅ Invalidation completed successfully!`);
          return true;
        } else if (status === 'InProgress') {
          console.log(`⏳ Invalidation in progress, checking again in ${pollInterval/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          polledTime += pollInterval;
        } else {
          console.log(`⚠️  Unexpected status: ${status}`);
          return false;
        }
      }
      
      console.log(`⏰ Polling timeout reached. Please check invalidation status manually.`);
      return false;
    } catch (error) {
      console.error(`❌ Failed to monitor invalidation progress:`, error.message);
      return false;
    }
  }

  /**
   * Create CloudFront invalidation for specified paths
   */
  async invalidateCloudFront(paths, monitorProgress = true) {
    if (!this.distributionId) {
      console.log('⚠️  No CloudFront distribution ID provided, skipping invalidation');
      return null;
    }

    if (!paths || paths.length === 0) {
      console.log('⚠️  No invalidation paths provided, skipping invalidation');
      return null;
    }

    try {
      console.log(`🔄 Creating CloudFront invalidation for distribution: ${this.distributionId}`);
      console.log(`📝 Paths to invalidate: ${paths.join(', ')}`);

      const command = new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: {
          Paths: {
            Quantity: paths.length,
            Items: paths
          },
          CallerReference: `s3-upload-${Date.now()}`
        }
      });

      const result = await this.cloudFrontClient.send(command);
      
      console.log(`✅ CloudFront invalidation created successfully!`);
      console.log(`🆔 Invalidation ID: ${result.Invalidation.Id}`);
      console.log(`📊 Initial Status: ${result.Invalidation.Status}`);
      
      const invalidationId = result.Invalidation.Id;
      
      // Monitor progress if requested
      if (monitorProgress && result.Invalidation.Status !== 'Completed') {
        console.log('');
        const success = await this.monitorInvalidationProgress(invalidationId);
        if (!success) {
          console.log(`⚠️  Progress monitoring ended. Check AWS Console for final status.`);
        }
      }
      
      return invalidationId;
    } catch (error) {
      console.error(`❌ Failed to create CloudFront invalidation:`, error.message);
      throw error;
    }
  }
}

// Command line interface
function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log('Usage: node index.js <dist-path> <s3-path> <bucket-name> [region] [distribution-id] [invalidation-path] [monitor-progress]');
    console.log('');
    console.log('Arguments:');
    console.log('  dist-path        - Local absolute path to dist folder containing _astro and category folders');
    console.log('  s3-path          - S3 path where folders should be uploaded (e.g., "my-app/" or "production/")');
    console.log('  bucket-name      - S3 bucket name');
    console.log('  region           - AWS region (optional, defaults to us-east-1)');
    console.log('  distribution-id  - CloudFront distribution ID (optional, for CDN invalidation)');
    console.log('  invalidation-path - Path pattern to invalidate in CloudFront (optional, e.g., "/website/app/*")');
    console.log('  monitor-progress - Whether to monitor invalidation progress (optional, default: true)');
    console.log('');
    console.log('Examples:');
    console.log('  node index.js /path/to/dist my-app/ my-bucket');
    console.log('  node index.js /path/to/dist production/ my-bucket us-west-2');
    console.log('  node index.js /path/to/dist website/app/ my-bucket us-east-1 E1DTLETE7MR3SY "/website/app/*"');
    console.log('  node index.js /path/to/dist website/app/ my-bucket us-east-1 E1DTLETE7MR3SY "/website/app/*" false');
    console.log('');
    console.log('Environment variables:');
    console.log('  AWS_ACCESS_KEY_ID - Your AWS access key');
    console.log('  AWS_SECRET_ACCESS_KEY - Your AWS secret key');
    console.log('  AWS_REGION - AWS region (defaults to us-east-1)');
    console.log('');
    console.log('Note: Environment variables can be set via:');
    console.log('  - .env file in the same directory as this script');
    console.log('  - System environment variables');
    console.log('  - AWS CLI configuration (aws configure)');
    console.log('');
    console.log('Features:');
    console.log('  - Automatically deletes existing _astro and category folders from S3');
    console.log('  - Uploads _astro folder with cache control: "public, max-age=31536000, immutable"');
    console.log('  - Uploads category folder with default cache control settings');
    console.log('  - Optional CloudFront CDN invalidation after successful upload');
    process.exit(1);
  }

  const [distPath, s3Path, bucketName, region, distributionId, invalidationPath, monitorProgressStr] = args;
  
  // Parse monitor progress parameter
  const monitorProgress = monitorProgressStr === undefined ? true : monitorProgressStr.toLowerCase() !== 'false';
  
  // Validate AWS credentials
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('❌ Error: AWS credentials not found!');
    console.error('Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
    console.error('You can also use AWS CLI: aws configure');
    process.exit(1);
  }

  const uploader = new S3Uploader(bucketName, region, distributionId);
  
  uploader.uploadDist(distPath, s3Path)
    .then(async () => {
      console.log('🎉 Upload completed successfully!');
      
      // Perform CloudFront invalidation if distribution ID and path are provided
      if (distributionId && invalidationPath) {
        try {
          console.log('');
          console.log('🔄 Starting CloudFront invalidation...');
          const invalidationPaths = invalidationPath.split(',').map(path => path.trim());
          await uploader.invalidateCloudFront(invalidationPaths, monitorProgress);
          console.log('🎉 CloudFront invalidation completed successfully!');
        } catch (invalidationError) {
          console.error('⚠️  CloudFront invalidation failed:', invalidationError.message);
          console.log('📝 Upload was successful, but invalidation failed. You may need to manually invalidate the cache.');
        }
      }
      
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Upload failed:', error.message);
      process.exit(1);
    });
}

// Run the script if called directly
main();

export default S3Uploader;
